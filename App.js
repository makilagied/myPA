import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, FlatList, Vibration, Keyboard, LayoutAnimation, Platform, Pressable, ScrollView,
  StyleSheet, Switch, Text, TextInput, View, useColorScheme, useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Linking, Modal } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import * as Notifications from 'expo-notifications';
import { REPEATS, REPEAT_LABEL, completeTask, occurrenceStored, pad, parseLocal, startOfDay, toStored } from './src/dates';
import { askClaude } from './src/claude';
import {
  DEFAULT_ASSISTANT, clearChat, defaultPrefs, getApiKey, getAssistantName, getPrefs, getUserName,
  loadChat, loadData, newId, saveChat, saveData, setApiKey, setAssistantName, setPrefs, setUserName,
} from './src/storage';
import { ensurePermission, syncReminders } from './src/reminders';
import { requestWidgetUpdate } from 'react-native-android-widget';
import { renderAgendaWidget } from './src/widget/AgendaWidget';
import { startVoice, stopVoice, voiceAvailable } from './src/voice';
import {
  MAX_RECIPIENTS, applyResults, channelOf, openOverlaySettings, requestCallPermission, startRingtone, stopRingtone, typeOf, getCommsStatus, getSims, hasPhoneStatePermission, hasSmsPermission, nativeAvailable,
  normalizeNumber, openAppSettings, openBatterySettings, openExactAlarmSettings, placeCall, recipientsOf,
  requestPhoneStatePermission, requestSmsPermission, syncTexts, takeResults, validNumber,
} from './src/comms';
import { ContactPicker } from './src/ContactPicker';

// ---------- theme ----------
const light = {
  bg: '#F4F5FA', card: '#FFFFFF', text: '#111827', muted: '#6B7280', border: '#E5E7EB',
  primary: '#5B4DF0', primarySoft: '#EEEBFF', onPrimary: '#FFFFFF', botBubble: '#FFFFFF',
  danger: '#DC2626', dangerSoft: '#FEE2E2', warnSoft: '#FEF3C7', warn: '#92400E', success: '#16A34A',
};
const dark = {
  bg: '#0E1015', card: '#181B22', text: '#F3F4F6', muted: '#9CA3AF', border: '#262A33',
  primary: '#8B7FFF', primarySoft: '#262248', onPrimary: '#0E1015', botBubble: '#1F2330',
  danger: '#F87171', dangerSoft: '#3A1D1D', warnSoft: '#3A2F14', warn: '#FCD34D', success: '#4ADE80',
};

const BRIEF_PROMPT = 'Give me my morning briefing: what is on my calendar and task list today, anything overdue, and what I should prioritise.';

const SUGGESTIONS = [
  '☀️ Give me my morning briefing',
  'Remind me to call mum tomorrow at 6pm',
  'Schedule a meeting Friday 10am',
  'Save a note: wifi password is ...',
];

const greeting = (a, u) =>
  `Hi${u ? ' ' + u : ''}! I'm ${a}, your personal secretary. Tell me what to schedule, remember, or track.`;

const timeOfDay = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

// keep API history bounded without splitting tool_use / tool_result pairs
function trimHistory(h, turns = 12) {
  const starts = h.map((m, i) => (m.role === 'user' && typeof m.content === 'string' ? i : -1)).filter((i) => i >= 0);
  if (starts.length <= turns) return h;
  return h.slice(starts[starts.length - turns]);
}

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmt = (s) => {
  const d = new Date(s);
  if (isNaN(d)) return s;
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  const date = d.toLocaleDateString([], opts);
  return s.includes('T') ? `${date} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : date;
};

// Keyboard height, applied as bottom padding. Android is edge-to-edge (the window no longer
// resizes for the keyboard), and KeyboardAvoidingView is unreliable there, so we do it ourselves.
function useKeyboardHeight() {
  const [h, setH] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const set = (v, e) => {
      LayoutAnimation.configureNext(LayoutAnimation.create(e?.duration || 200, 'easeInEaseOut', 'opacity'));
      setH(v);
    };
    const subs = [
      Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) => set(e.endCoordinates.height, e)),
      Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', (e) => set(0, e)),
    ];
    return () => subs.forEach((x) => x.remove());
  }, []);
  // On Android, React Native reports the keyboard height minus the navigation bar, but our
  // layout runs edge-to-edge underneath it, so add that bar back to avoid the overlap.
  const { bottom } = useSafeAreaInsets();
  return h > 0 && Platform.OS === 'android' ? h + bottom : h;
}

// ---------- root ----------
export default function Root() {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  );
}

function App() {
  const systemScheme = useColorScheme();
  const [prefs, setPrefsState] = useState(defaultPrefs);
  const scheme = prefs.theme === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : prefs.theme;
  const T = scheme === 'dark' ? dark : light;
  const s = useMemo(() => makeStyles(T), [scheme]);
  const insets = useSafeAreaInsets();
  const kb = useKeyboardHeight();

  const [tab, setTab] = useState('chat');
  const [data, setData] = useState({ tasks: [], notes: [], events: [] });
  const [apiKey, setKey] = useState('');
  const [name, setName] = useState('');
  const [assistant, setAssistant] = useState(DEFAULT_ASSISTANT);
  const [ready, setReady] = useState(false);
  const [history, setHistory] = useState([]);
  const [display, setDisplay] = useState([]);
  const [busy, setBusy] = useState(false);
  const [briefTrigger, setBriefTrigger] = useState(0);
  const [agendaIntent, setAgendaIntent] = useState(null);
  const [fake, setFake] = useState(null); // { name } while the fake call screen is up
  const fakeTimer = useRef(null);

  useEffect(() => {
    (async () => {
      const [d, k, n, a, chat, p] = await Promise.all([loadData(), getApiKey(), getUserName(), getAssistantName(), loadChat(), getPrefs()]);
      setData(d); setKey(k); setName(n); setAssistant(a); setPrefsState(p);
      if (chat?.display?.length) { setDisplay(chat.display); setHistory(chat.history || []); }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (ready) saveChat({ display: display.slice(-100), history });
  }, [display, history, ready]);

  useEffect(() => {
    if (ready) syncReminders(data, prefs);
  }, [data, prefs.reminders, prefs.briefing, prefs.briefingTime, ready]);

  const changePrefs = async (patch) => {
    const next = { ...prefs, ...patch };
    setPrefsState(next);
    await setPrefs(next);
    if (patch.reminders || patch.briefing) await ensurePermission();
  };

  useEffect(() => {
    try {
      const sub = Notifications.addNotificationResponseReceivedListener((r) => {
        const d = r.notification.request.content.data || {};
        if (d.type === 'briefing') setBriefTrigger((n) => n + 1);
        else if (d.type === 'whatsapp' && d.url) Linking.openURL(d.url).catch(() => {});
        else if (d.type === 'fakecall') { clearTimeout(fakeTimer.current); setFake({ name: d.name || 'Unknown' }); }
      });
      return () => sub.remove();
    } catch {}
  }, []);

  useEffect(() => {
    if (briefTrigger > 0 && ready && !busy) { setTab('chat'); send(BRIEF_PROMPT); }
  }, [briefTrigger]);

  const dataRef = useRef(data);
  dataRef.current = data;

  // Pull results recorded by the native alarm (sent / failed / missed) into the texts list.
  const ingestResults = () => {
    const cur = dataRef.current;
    const next = applyResults(cur.texts || [], takeResults());
    if (next !== (cur.texts || [])) { const d = { ...cur, texts: next }; dataRef.current = d; setData(d); saveData(d); }
  };

  useEffect(() => {
    if (!ready) return;
    ingestResults();
    const sub = AppState.addEventListener('change', (a) => a === 'active' && ingestResults());
    return () => sub.remove();
  }, [ready]);

  const textsKey = JSON.stringify((data.texts || []).map((t) => [t.id, t.number, t.message, t.at, t.repeat, t.status, t.type, t.channel]));
  useEffect(() => {
    if (ready) syncTexts(data.texts || []);
  }, [textsKey, ready]);

  // Keep the home-screen widget in sync with the data.
  useEffect(() => {
    if (!ready || Platform.OS !== 'android') return;
    try {
      requestWidgetUpdate({
        widgetName: 'Agenda',
        renderWidget: (info) => renderAgendaWidget(data, info),
      }).catch(() => {});
    } catch {}
  }, [data, ready]);

  // Deep links: the widget's + button opens mypa://add/task
  useEffect(() => {
    if (!ready) return;
    const handle = (url) => {
      if (url && url.startsWith('mypa://add/')) {
        const kind = url.replace('mypa://add/', '').replace(/\/$/, '');
        if (['task', 'event', 'note', 'text'].includes(kind)) {
          setTab('agenda');
          setAgendaIntent({ kind, n: Date.now() });
        }
      }
    };
    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, [ready]);

  const startFakeCall = async ({ name, delay }) => {
    const nm = name || 'Unknown';
    clearTimeout(fakeTimer.current);
    if (delay <= 0) return setFake({ name: nm });
    let id = null;
    try {
      if (await ensurePermission()) {
        id = await Notifications.scheduleNotificationAsync({
          content: { title: nm, body: 'Incoming call', sound: true, data: { type: 'fakecall', name: nm } },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: delay, channelId: 'reminders' },
        });
      }
    } catch {}
    // If the app is open when it's time, show the call screen directly instead of the notification.
    fakeTimer.current = setTimeout(() => {
      if (AppState.currentState === 'active') {
        if (id) Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
        setFake({ name: nm });
      }
    }, delay * 1000);
    Alert.alert('Fake call set', `${nm} will ring in ${delay >= 60 ? delay / 60 + ' min' : delay + ' s'}. You can lock your phone: tap the notification to open the call screen.`);
  };

  const updateData = (d) => { setData(d); saveData(d); };
  const push = (role, text, extra) =>
    setDisplay((d) => [...d, { id: newId(), role, text, ts: Date.now(), ...extra }]);

  const send = async (raw, isRetry = false) => {
    const text = raw.trim();
    if (!text || busy) return false;
    if (!apiKey) { setTab('settings'); return false; }
    if (!isRetry) push('user', text);
    setBusy(true);
    try {
      const out = await askClaude({
        apiKey, userName: name, assistantName: assistant, data,
        messages: trimHistory([...history, { role: 'user', content: text }]),
      });
      setHistory(out.messages);
      if (out.data !== data) updateData(out.data);
      push('assistant', out.reply || 'Done.');
    } catch (e) {
      push('error', e.message, { retry: text });
    } finally {
      setBusy(false);
    }
    return true;
  };

  const retry = (msg) => {
    setDisplay((d) => d.filter((m) => m.id !== msg.id));
    send(msg.retry, true);
  };

  const resetChat = () =>
    Alert.alert('Clear conversation?', 'Your tasks, events and notes are kept.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => { setDisplay([]); setHistory([]); await clearChat(); } },
    ]);

  if (!ready) return <View style={[s.flex, s.center]}><ActivityIndicator color={T.primary} /></View>;

  const openTasks = data.tasks.filter((t) => !t.done).length;
  const selectTab = (k) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));
    setTab(k);
  };

  return (
    <View style={[s.flex, { paddingTop: insets.top }]}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Header s={s} T={T} assistant={assistant} busy={busy} onClear={tab === 'chat' && display.length ? resetChat : null} />
      <View style={[s.flex, { paddingBottom: kb }]}>
        {tab === 'chat' && (
          <Chat s={s} T={T} {...{ apiKey, name, assistant, display, busy, send, retry }} goSettings={() => setTab('settings')} />
        )}
        {tab === 'agenda' && <Agenda s={s} T={T} data={data} updateData={updateData} onBrief={() => setBriefTrigger((n) => n + 1)} intent={agendaIntent} onIntentHandled={() => setAgendaIntent(null)} onFakeCall={startFakeCall} />}
        {tab === 'settings' && (
          <Settings s={s} T={T} {...{ apiKey, name, assistant, prefs, changePrefs }}
            onSave={async (k, n, a) => {
              const an = a || DEFAULT_ASSISTANT;
              await Promise.all([setApiKey(k), setUserName(n), setAssistantName(an)]);
              setKey(k); setName(n); setAssistant(an);
              setTab('chat');
            }} />
        )}
      </View>
      {fake && <FakeCallScreen name={fake.name} onClose={() => setFake(null)} />}
      {kb === 0 && (
        <View style={[s.navWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={s.navBar}>
            {[
              ['agenda', 'calendar', 'Agenda', openTasks],
              ['chat', 'chatbubble-ellipses', 'Chat'],
              ['settings', 'settings', 'Settings'],
            ].map(([k, icon, label, badge]) => {
              const active = tab === k;
              return (
                <Pressable
                  key={k} onPress={() => selectTab(k)} style={[s.navItem, active && s.navItemActive]}
                  accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label}
                >
                  <View>
                    <Ionicons name={active ? icon : `${icon}-outline`} size={22} color={active ? T.primary : T.muted} />
                    {badge ? <View style={s.navBadge}><Text style={s.badgeText}>{badge > 9 ? '9+' : badge}</Text></View> : null}
                  </View>
                  {active && <Text style={s.navLabel}>{label}</Text>}
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}

function Header({ s, T, assistant, busy, onClear }) {
  return (
    <View style={s.header}>
      <View style={s.avatar}><Text style={s.avatarText}>{(assistant[0] || 'J').toUpperCase()}</Text></View>
      <View style={s.flex1}>
        <Text style={s.title}>{assistant}</Text>
        <Text style={s.subtitle}>{busy ? 'thinking…' : 'myPA · your personal secretary'}</Text>
      </View>
      {onClear && (
        <Pressable onPress={onClear} hitSlop={10} accessibilityLabel="Clear conversation">
          <Text style={{ color: T.muted, fontSize: 13 }}>Clear</Text>
        </Pressable>
      )}
    </View>
  );
}

// ---------- chat ----------
function Chat({ s, T, apiKey, name, assistant, display, busy, send, retry, goSettings }) {
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState('');
  const baseRef = useRef('');
  const listRef = useRef(null);
  const empty = display.length === 0;

  useEffect(() => () => { if (voiceAvailable) stopVoice(); }, []);
  useEffect(() => {
    const sub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () =>
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50));
    return () => sub.remove();
  }, []);

  const toggleMic = async () => {
    if (listening) return stopVoice();
    setVoiceErr('');
    baseRef.current = input ? input.trim() + ' ' : '';
    try {
      setListening(true);
      await startVoice({
        onText: (t) => setInput(baseRef.current + t),
        onEnd: () => setListening(false),
        onError: (m) => { setListening(false); setVoiceErr(m); },
      });
    } catch (e) {
      setListening(false);
      setVoiceErr(e.message);
    }
  };

  const submit = async (text) => {
    const v = (text ?? input).trim();
    if (!v) return;
    setInput('');
    const ok = await send(v);
    if (ok === false && !apiKey) setInput(v);
  };

  return (
    <View style={s.flex}>
      {!apiKey && (
        <Pressable onPress={goSettings} style={s.banner}>
          <Text style={{ color: T.warn, flex: 1 }}>Add your Claude API key to get started</Text>
          <Text style={{ color: T.warn, fontWeight: '700' }}>Set up →</Text>
        </Pressable>
      )}
      <FlatList
        ref={listRef}
        data={display}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 14, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <View style={s.emptyWrap}>
            <View style={[s.avatar, { width: 64, height: 64, borderRadius: 32 }]}>
              <Text style={[s.avatarText, { fontSize: 28 }]}>{(assistant[0] || 'J').toUpperCase()}</Text>
            </View>
            <Text style={s.hello}>{timeOfDay()}{name ? ', ' + name : ''}</Text>
            <Text style={s.helloSub}>{greeting(assistant, '').replace('Hi! ', '')}</Text>
          </View>
        }
        renderItem={({ item }) => <Bubble s={s} T={T} item={item} retry={retry} />}
        ListFooterComponent={busy ? <TypingDots s={s} T={T} /> : null}
      />
      {empty && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={s.chips} keyboardShouldPersistTaps="handled">
          {SUGGESTIONS.map((q) => (
            <Pressable key={q} style={s.chip} onPress={() => submit(q)}><Text style={s.chipText}>{q}</Text></Pressable>
          ))}
        </ScrollView>
      )}
      {voiceErr ? <Text style={{ color: T.danger, paddingHorizontal: 16, paddingBottom: 4, fontSize: 12.5 }}>{voiceErr}</Text> : null}
      <View style={s.inputRow}>
        <TextInput
          style={s.input} value={input} onChangeText={setInput}
          placeholder={listening ? 'Listening…' : `Message ${assistant}…`}
          placeholderTextColor={listening ? T.danger : T.muted} multiline
        />
        {voiceAvailable && (
          <Pressable
            style={[s.micBtn, listening && { backgroundColor: T.danger, borderColor: T.danger }]}
            onPress={toggleMic} accessibilityLabel={listening ? 'Stop listening' : 'Voice input'}
          >
            <Ionicons name={listening ? 'stop' : 'mic-outline'} size={22} color={listening ? '#fff' : T.text} />
          </Pressable>
        )}
        <Pressable
          style={[s.sendBtn, (!input.trim() || busy) && { opacity: 0.4 }]}
          onPress={() => submit()} disabled={!input.trim() || busy} accessibilityLabel="Send"
        >
          <Text style={s.sendIcon}>↑</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Bubble({ s, T, item, retry }) {
  const mine = item.role === 'user';
  const err = item.role === 'error';
  const time = item.ts ? new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <View style={[s.row, mine && { alignItems: 'flex-end' }]}>
      <View style={[s.bubble, mine ? s.userB : err ? s.errB : s.botB]}>
        <Text selectable style={{ color: mine ? T.onPrimary : err ? T.danger : T.text, fontSize: 15.5, lineHeight: 21 }}>
          {item.text}
        </Text>
        {err && item.retry ? (
          <Pressable onPress={() => retry(item)} style={{ marginTop: 6 }}>
            <Text style={{ color: T.danger, fontWeight: '700' }}>Tap to retry</Text>
          </Pressable>
        ) : null}
      </View>
      {time ? <Text style={s.time}>{time}</Text> : null}
    </View>
  );
}

function TypingDots({ s, T }) {
  const [n, setN] = useState(1);
  useEffect(() => { const t = setInterval(() => setN((x) => (x % 3) + 1), 350); return () => clearInterval(t); }, []);
  return (
    <View style={[s.bubble, s.botB, { alignSelf: 'flex-start', marginTop: 4 }]}>
      <Text style={{ color: T.muted, fontSize: 20, letterSpacing: 2 }}>{'•'.repeat(n)}</Text>
    </View>
  );
}

// ---------- agenda ----------
function Agenda({ s, T, data, updateData, onBrief, intent, onIntentHandled, onFakeCall }) {
  const [seg, setSeg] = useState('tasks');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // { kind, item, isNew }
  const today = localDay();

  useEffect(() => {
    if (!intent) return;
    setSeg({ task: 'tasks', event: 'events', note: 'notes', text: 'contact' }[intent.kind]);
    setEditing({ kind: intent.kind, item: {}, isNew: true });
    onIntentHandled?.();
  }, [intent?.n]);

  const KEYS = { task: 'tasks', event: 'events', note: 'notes', text: 'texts' };
  const SEG_KIND = { tasks: 'task', events: 'event', notes: 'note', contact: 'text' };

  const saveEdit = (patch) => {
    const { kind, item, isNew } = editing;
    const key = KEYS[kind];
    const now = new Date().toISOString();
    if (isNew) {
      const base = { id: newId(), created: now, ...(kind === 'task' ? { done: false } : {}), ...(kind === 'note' ? { updated: now } : {}), ...(kind === 'text' ? { status: 'scheduled' } : {}) };
      updateData({ ...data, [key]: [...(data[key] || []), { ...base, ...patch }] });
    } else {
      const extra = kind === 'note' ? { updated: now } : kind === 'text' ? { status: 'scheduled', error: null, doneAt: null } : {};
      updateData({ ...data, [key]: data[key].map((x) => (x.id === item.id ? { ...x, ...patch, ...extra } : x)) });
    }
    setEditing(null);
  };

  const tasks = [...data.tasks].sort((a, b) => (a.done - b.done) || (a.due || '9').localeCompare(b.due || '9'));
  const sod = startOfDay();
  const events = data.events
    .map((e) => ({ ...e, eff: occurrenceStored(e.start, e.repeat, sod) }))
    .sort((a, b) => a.eff.localeCompare(b.eff));
  const todayEvents = events.filter((e) => e.eff.slice(0, 10) === today).length;
  const upcoming = events.filter((e) => e.eff.slice(0, 10) >= today);
  const past = events.filter((e) => e.eff.slice(0, 10) < today);
  const open = data.tasks.filter((t) => !t.done).length;

  const q = query.trim().toLowerCase();
  const notes = data.notes
    .filter((n) => !q || (n.title || '').toLowerCase().includes(q) || (n.text || '').toLowerCase().includes(q))
    .sort((a, b) => (!!b.pinned - !!a.pinned) || (b.updated || b.created || '').localeCompare(a.updated || a.created || ''));

  const remove = (key, id) => updateData({ ...data, [key]: data[key].filter((x) => x.id !== id) });
  const toggle = (id) =>
    updateData({ ...data, tasks: data.tasks.map((t) => (t.id !== id ? t : t.done ? { ...t, done: false } : completeTask(t))) });
  const pin = (id) => updateData({ ...data, notes: data.notes.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)) });

  const Del = ({ onPress }) => (
    <Pressable onPress={onPress} hitSlop={10} accessibilityLabel="Delete"><Ionicons name="close" size={20} color={T.muted} /></Pressable>
  );

  const EventCard = ({ e, dim }) => (
    <Pressable style={[s.card, dim && { opacity: 0.55 }]} onPress={() => setEditing({ kind: 'event', item: e })}>
      <View style={s.flex1}>
        <Text style={s.cardTitle}>{e.title}</Text>
        <Text style={s.muted}>{fmt(e.eff)}{e.repeat && e.repeat !== 'none' ? ' · ↻ ' + REPEAT_LABEL[e.repeat] : ''}{e.location ? ' · 📍 ' + e.location : ''}</Text>
      </View>
      <Del onPress={() => remove('events', e.id)} />
    </Pressable>
  );

  return (
    <View style={s.flex}>
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 90 }} keyboardShouldPersistTaps="handled">
        <View style={s.stats}>
          <View style={s.stat}><Text style={s.statNum}>{todayEvents}</Text><Text style={s.muted}>events today</Text></View>
          <View style={s.stat}><Text style={s.statNum}>{open}</Text><Text style={s.muted}>open tasks</Text></View>
          <View style={s.stat}><Text style={s.statNum}>{data.notes.length}</Text><Text style={s.muted}>notes</Text></View>
        </View>

        <Pressable style={s.briefBtn} onPress={onBrief}>
          <Text style={{ color: T.primary, fontWeight: '700' }}>☀️ Brief me on today</Text>
        </Pressable>

        <View style={s.seg}>
          {[['tasks', 'Tasks'], ['events', 'Events'], ['notes', 'Notes'], ['contact', 'Contact']].map(([k, l]) => (
            <Pressable key={k} style={[s.segItem, seg === k && s.segActive]} onPress={() => setSeg(k)}>
              <Text style={[s.segText, seg === k && { color: T.onPrimary, fontWeight: '700' }]}>{l}</Text>
            </Pressable>
          ))}
        </View>

        {seg === 'notes' && (
          <View style={s.addRow}>
            <TextInput style={[s.input, s.flex1]} value={query} onChangeText={setQuery} placeholder="Search notes…"
              placeholderTextColor={T.muted} returnKeyType="search" />
          </View>
        )}

        {seg === 'tasks' && (
          tasks.length === 0 ? <Empty s={s} icon="✅" text="No tasks yet. Tap + to add one, or ask your assistant." /> :
          tasks.map((t) => {
            const overdue = !t.done && t.due && t.due.slice(0, 10) < today;
            return (
              <Pressable key={t.id} style={s.card} onPress={() => setEditing({ kind: 'task', item: t })}>
                <Pressable onPress={() => toggle(t.id)} hitSlop={8} accessibilityLabel="Toggle done">
                  <View style={[s.check, t.done && { backgroundColor: T.success, borderColor: T.success }]}>
                    {t.done ? <Ionicons name="checkmark" size={15} color="#fff" /> : null}
                  </View>
                </Pressable>
                <View style={s.flex1}>
                  <Text style={[s.cardTitle, t.done && { textDecorationLine: 'line-through', color: T.muted }]}>{t.title}</Text>
                  {t.due ? <Text style={[s.muted, overdue && { color: T.danger, fontWeight: '700' }]}>{overdue ? 'Overdue · ' : 'Due '}{fmt(t.due)}{t.repeat && t.repeat !== 'none' ? ' · ↻ ' + REPEAT_LABEL[t.repeat] : ''}</Text> : null}
                </View>
                <Del onPress={() => remove('tasks', t.id)} />
              </Pressable>
            );
          })
        )}

        {seg === 'events' && (
          events.length === 0 ? <Empty s={s} icon="🗓️" text="No events yet. Tap + to add one, or ask your assistant." /> : (
            <>
              {upcoming.map((e) => <EventCard key={e.id} e={e} />)}
              {past.length > 0 && <Text style={s.section}>Past</Text>}
              {past.map((e) => <EventCard key={e.id} e={e} dim />)}
            </>
          )
        )}

        {seg === 'notes' && (
          notes.length === 0 ? <Empty s={s} icon="📝" text={q ? 'No notes match your search.' : 'Your notebook is empty. Tap + to write your first note.'} /> :
          notes.map((n) => (
            <Pressable key={n.id} style={[s.card, { alignItems: 'flex-start' }]} onPress={() => setEditing({ kind: 'note', item: n })}>
              <View style={s.flex1}>
                {n.title ? <Text style={s.cardTitle} numberOfLines={1}>{n.title}</Text> : null}
                <Text style={[n.title ? s.muted : s.cardTitle, !n.title && { fontWeight: '400' }, { marginTop: n.title ? 4 : 0 }]} numberOfLines={4}>{n.text}</Text>
                <Text style={[s.muted, { fontSize: 11, marginTop: 6 }]}>{new Date(n.updated || n.created || Date.now()).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</Text>
              </View>
              <Pressable onPress={() => pin(n.id)} hitSlop={10} accessibilityLabel={n.pinned ? 'Unpin' : 'Pin'}>
                <Ionicons name={n.pinned ? 'pin' : 'pin-outline'} size={20} color={n.pinned ? T.primary : T.muted} />
              </Pressable>
              <Del onPress={() => remove('notes', n.id)} />
            </Pressable>
          ))
        )}
        {seg === 'contact' && (
          <ContactPanel s={s} T={T} texts={data.texts || []} onEdit={(t) => setEditing({ kind: 'text', item: t })}
            onDelete={(id) => remove('texts', id)} onFakeCall={onFakeCall} />
        )}
      </ScrollView>

      <Pressable style={s.fab} onPress={() => setEditing({ kind: SEG_KIND[seg], item: {}, isNew: true })} accessibilityLabel={`New ${SEG_KIND[seg]}`}>
        <Ionicons name="add" size={30} color={T.onPrimary} />
      </Pressable>

      {editing && editing.kind === 'text' && (
        <TextSheet s={s} T={T} {...editing} onClose={() => setEditing(null)}
          onSave={async (patch) => {
            if (nativeAvailable && patch.type === 'call') {
              if (!(await requestCallPermission())) {
                Alert.alert('Call permission denied', 'The call is saved, but it cannot be placed until you allow Phone access in app settings.');
              }
            } else if (nativeAvailable && patch.channel !== 'whatsapp' && !(await hasSmsPermission())) {
              const ok = await requestSmsPermission();
              if (!ok) Alert.alert('SMS permission denied', 'The text is saved, but it will not send until you allow SMS in app settings.');
            }
            saveEdit(patch);
          }} />
      )}
      {editing && editing.kind !== 'text' && <EditSheet s={s} T={T} {...editing} onClose={() => setEditing(null)} onSave={saveEdit} />}
    </View>
  );
}

const FAKE_DELAYS = [[0, 'Now'], [10, '10 s'], [30, '30 s'], [60, '1 min'], [300, '5 min']];

function FakeCallPanel({ s, T, onStart }) {
  const [name, setName] = useState('Mum');
  const [delay, setDelay] = useState(30);
  return (
    <View style={s.panel}>
      <Text style={s.muted}>Shows a realistic incoming-call screen on this phone, with your real ringtone, so you can step away from a situation. It never calls anyone.</Text>
      <Text style={[s.label, { marginTop: 12 }]}>Caller name</Text>
      <TextInput style={s.field} value={name} onChangeText={setName} placeholder="Who is calling?" placeholderTextColor={T.muted} />
      <Text style={s.label}>Ring in</Text>
      <View style={[s.seg, { marginBottom: 14 }]}>
        {FAKE_DELAYS.map(([v, l]) => (
          <Pressable key={v} style={[s.segItem, delay === v && s.segActive]} onPress={() => setDelay(v)}>
            <Text style={[s.segText, delay === v && { color: T.onPrimary, fontWeight: '700' }]}>{l}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable style={s.primaryBtn} onPress={() => onStart({ name: name.trim(), delay })}>
        <Text style={{ color: T.onPrimary, fontWeight: '700' }}>{delay === 0 ? 'Ring now' : 'Start fake call'}</Text>
      </Pressable>
    </View>
  );
}

function FakeCallScreen({ name, onClose }) {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState('ringing'); // ringing | connected
  const [secs, setSecs] = useState(0);

  useEffect(() => {
    if (state !== 'ringing') return;
    startRingtone();
    Vibration.vibrate([0, 900, 700], true);
    const t = setTimeout(onClose, 45000); // unanswered: "missed"
    return () => { clearTimeout(t); stopRingtone(); Vibration.cancel(); };
  }, [state]);

  useEffect(() => {
    if (state !== 'connected') return;
    const i = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, [state]);

  const clock = `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;
  const Round = ({ color, icon, label, onPress, rotate }) => (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <Pressable onPress={onPress} accessibilityLabel={label}
        style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={32} color="#fff" style={rotate ? { transform: [{ rotate: '135deg' }] } : null} />
      </Pressable>
      <Text style={{ color: '#CBD5E1', fontSize: 13 }}>{label}</Text>
    </View>
  );

  return (
    <Modal visible animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0F172A', paddingTop: insets.top + 70, paddingBottom: insets.bottom + 50, alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Text style={{ color: '#fff', fontSize: 36, fontWeight: '300' }}>{name}</Text>
          <Text style={{ color: '#94A3B8', fontSize: 16 }}>{state === 'ringing' ? 'mobile · Incoming call…' : clock}</Text>
        </View>
        <View style={{ width: 130, height: 130, borderRadius: 65, backgroundColor: '#334155', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 54, fontWeight: '300' }}>{(name[0] || '?').toUpperCase()}</Text>
        </View>
        {state === 'ringing' ? (
          <View style={{ flexDirection: 'row', width: '100%', justifyContent: 'space-around' }}>
            <Round color="#EF4444" icon="call" label="Decline" rotate onPress={onClose} />
            <Round color="#22C55E" icon="call" label="Accept" onPress={() => setState('connected')} />
          </View>
        ) : (
          <Round color="#EF4444" icon="call" label="End" rotate onPress={onClose} />
        )}
      </View>
    </Modal>
  );
}

const STATUS_STYLE = (T) => ({
  scheduled: { label: 'Scheduled', color: T.primary, bg: T.primarySoft },
  sent: { label: 'Sent', color: T.success, bg: T.primarySoft },
  partial: { label: 'Partly sent', color: T.warn, bg: T.warnSoft },
  reminded: { label: 'Reminder sent', color: T.success, bg: T.primarySoft },
  failed: { label: 'Failed', color: T.danger, bg: T.dangerSoft },
  missed: { label: 'Missed', color: T.warn, bg: T.warnSoft },
});

function useCommsStatus() {
  const [st, setSt] = useState(null);
  const refresh = async () => setSt(await getCommsStatus());
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (a) => a === 'active' && refresh());
    return () => sub.remove();
  }, []);
  return [st, refresh];
}

function recipientLabel(t) {
  const r = recipientsOf(t);
  if (!r.length) return 'No recipient';
  const first = r[0].name || r[0].number;
  return r.length === 1 ? first : `${first} +${r.length - 1} more`;
}

function ContactPanel({ s, T, texts, onEdit, onDelete, onFakeCall }) {
  const [dial, setDial] = useState('');
  const [picking, setPicking] = useState(false);
  const [st, refresh] = useCommsStatus();
  const labels = STATUS_STYLE(T);
  const needOverlay = texts.some((t) => typeOf(t) === 'call' && t.status === 'scheduled');

  const sorted = [...texts].sort((a, b) => {
    const pa = a.status === 'scheduled' ? 0 : 1;
    const pb = b.status === 'scheduled' ? 0 : 1;
    return pa - pb || (pa === 0 ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at));
  });

  const Step = ({ ok, label, hint, action, actionLabel }) => (
    <View style={[s.keyRow, { marginTop: 8 }]}>
      <Ionicons name={ok ? 'checkmark-circle' : 'alert-circle'} size={20} color={ok ? T.success : T.warn} />
      <View style={s.flex1}>
        <Text style={{ color: T.text, fontWeight: '600', fontSize: 14 }}>{label}</Text>
        {!ok && <Text style={s.muted}>{hint}</Text>}
      </View>
      {!ok && <Pressable onPress={action} style={s.showBtn}><Text style={{ color: T.primary, fontWeight: '700' }}>{actionLabel}</Text></Pressable>}
    </View>
  );

  return (
    <View>
      {!nativeAvailable ? (
        <View style={[s.panel, { backgroundColor: T.warnSoft }]}>
          <Text style={{ color: T.warn, fontWeight: '700' }}>Development build needed</Text>
          <Text style={{ color: T.warn, marginTop: 4 }}>Automatic texts and direct calls only work in the myPA APK, not Expo Go. Calls will open your dialer instead.</Text>
        </View>
      ) : st && !(st.sms && st.exact && st.battery && (!needOverlay || st.overlay)) ? (
        <View style={s.panel}>
          <Text style={[s.label, { marginBottom: 0 }]}>Set up automatic sending</Text>
          <Step ok={st.sms} label="Allow sending SMS" hint="Needed to send texts for you." actionLabel="Allow"
            action={async () => { if (!(await requestSmsPermission())) openAppSettings(); refresh(); }} />
          <Step ok={st.exact} label="Allow exact alarms" hint="Lets texts go out at the exact minute." actionLabel="Open" action={openExactAlarmSettings} />
          <Step ok={st.battery} label="Unrestricted battery use" hint="Stops the phone from delaying or blocking texts." actionLabel="Open" action={openBatterySettings} />
          {needOverlay && <Step ok={st.overlay} label="Let scheduled calls start by themselves" hint="Android needs 'Display over other apps' to place a call from the background. Without it you get a tap-to-call notification instead." actionLabel="Open" action={openOverlaySettings} />}
        </View>
      ) : null}

      <Text style={s.section}>Call</Text>
      <View style={s.addRow}>
        <TextInput style={[s.input, s.flex1]} value={dial} onChangeText={setDial} placeholder="Phone number"
          placeholderTextColor={T.muted} keyboardType="phone-pad" />
        <Pressable style={s.micBtn} onPress={() => setPicking(true)} accessibilityLabel="Pick a contact">
          <Ionicons name="person-circle-outline" size={24} color={T.text} />
        </Pressable>
        <Pressable style={[s.sendBtn, !validNumber(dial) && { opacity: 0.4 }]} disabled={!validNumber(dial)}
          onPress={() => placeCall(dial)} accessibilityLabel="Call">
          <Ionicons name="call" size={20} color={T.onPrimary} />
        </Pressable>
      </View>
      {picking && <ContactPicker T={T} onClose={() => setPicking(false)} onDone={(list) => { setPicking(false); if (list[0]) setDial(list[0].number); }} />}

      <Text style={s.section}>Fake call</Text>
      <FakeCallPanel s={s} T={T} onStart={onFakeCall} />

      <Text style={s.section}>Scheduled texts and calls</Text>
      {sorted.length === 0 ? (
        <Empty s={s} icon="💬" text="Nothing scheduled. Tap + to schedule a text or a call. SMS and calls go out by themselves at the time you choose." />
      ) : sorted.map((t) => {
        const kind = typeOf(t);
        const wa = kind === 'text' && channelOf(t) === 'whatsapp';
        const base = labels[t.status] || labels.scheduled;
        const stl = kind === 'call' && t.status === 'sent' ? { ...base, label: 'Called' } : base;
        const rep = t.repeat && t.repeat !== 'none' ? ' · ↻ ' + REPEAT_LABEL[t.repeat] : '';
        const rs = recipientsOf(t);
        return (
          <Pressable key={t.id} style={[s.card, { alignItems: 'flex-start' }]} onPress={() => onEdit(t)}>
            <View style={s.flex1}>
              <Text style={s.cardTitle} numberOfLines={1}>{recipientLabel(t)}</Text>
              {rs.length === 1 && rs[0].name ? <Text style={s.muted}>{rs[0].number}</Text> : null}
              {kind === 'text' ? <Text style={{ color: T.text, marginTop: 6, fontSize: 14.5 }} numberOfLines={2}>{t.message}</Text> : null}
              <View style={[s.dtRow, { marginTop: 8 }]}>
                <View style={{ backgroundColor: stl.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <Text style={{ color: stl.color, fontSize: 12, fontWeight: '700' }}>{stl.label}</Text>
                </View>
                <Text style={[s.muted, { marginTop: 0 }]}>{kind === 'call' ? 'Call' : wa ? 'WhatsApp' : 'SMS'} · {fmt(t.at)}{rep}{t.sim && !wa ? ` · SIM ${t.sim.slot}` : ''}</Text>
              </View>
              {t.error ? <Text style={{ color: T.danger, fontSize: 12, marginTop: 4 }}>{t.error}</Text> : null}
              {t.lastStatus ? <Text style={s.muted}>Last: {t.lastStatus} {t.lastAt ? new Date(t.lastAt).toLocaleString() : ''}</Text> : null}
            </View>
            {rs.length === 1 && (
              <Pressable onPress={() => placeCall(rs[0].number, rs[0].name)} hitSlop={10} accessibilityLabel="Call">
                <Ionicons name="call-outline" size={21} color={T.primary} />
              </Pressable>
            )}
            <Pressable onPress={() => onDelete(t.id)} hitSlop={10} accessibilityLabel="Delete">
              <Ionicons name="close" size={20} color={T.muted} />
            </Pressable>
          </Pressable>
        );
      })}
    </View>
  );
}

function TextSheet({ s, T, item, isNew, onSave, onClose }) {
  const kb = useKeyboardHeight();
  const { height: winH } = useWindowDimensions();
  const [recipients, setRecipients] = useState(() => recipientsOf(item));
  const [typed, setTyped] = useState('');
  const [picking, setPicking] = useState(false);
  const [type, setType] = useState(item.type || 'text'); // 'text' | 'call'
  const [channel, setChannel] = useState(item.channel || 'sms'); // 'sms' | 'whatsapp'
  const [message, setMessage] = useState(item.message || '');
  const [when, setWhen] = useState(() => {
    if (item.at) return item.at;
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return toStored(d, true);
  });
  const [repeat, setRepeat] = useState(item.repeat || 'none');
  const [sim, setSim] = useState(item.sim || null);
  const [sims, setSims] = useState(null); // null = not loaded (needs phone permission)
  const [err, setErr] = useState('');

  const loadSims = async () => {
    if (!nativeAvailable) return;
    if (!(await hasPhoneStatePermission())) {
      const res = await requestPhoneStatePermission();
      if (res !== 'granted') {
        Alert.alert(
          'Phone access needed',
          res === 'never_ask_again'
            ? 'Android is blocking the prompt. Open app settings > Permissions > Phone and allow it. If there is no Phone option there, your installed app is older than this feature: rebuild and reinstall it.'
            : 'Allow phone access so myPA can list your SIM cards. If no prompt appeared, your installed app is older than this feature: rebuild and reinstall it.',
          [{ text: 'Not now', style: 'cancel' }, { text: 'Open settings', onPress: openAppSettings }],
        );
        return;
      }
    }
    const found = getSims();
    setSims(found);
    if (!found.length) setErr('No active SIM cards were found.');
  };
  useEffect(() => {
    if (nativeAvailable) hasPhoneStatePermission().then((ok) => ok && setSims(getSims()));
  }, []);

  const addRecipients = (list) => {
    if (type === 'call') { setRecipients(list.slice(0, 1)); setErr(''); return; }
    setRecipients((cur) => {
      const have = new Set(cur.map((r) => normalizeNumber(r.number)));
      const add = list.filter((r) => !have.has(normalizeNumber(r.number)));
      return [...cur, ...add];
    });
    setErr('');
  };

  const addTyped = () => {
    if (!validNumber(typed)) return setErr('Enter a valid phone number, e.g. +255712345678.');
    addRecipients([{ name: '', number: typed.trim() }]);
    setTyped('');
  };

  const save = () => {
    const wa = type === 'text' && channel === 'whatsapp';
    let list = typed.trim() && validNumber(typed) ? [...recipients, { name: '', number: typed.trim() }] : recipients;
    if (type === 'call') list = list.slice(0, 1);
    if (!list.length) return setErr(type === 'call' ? 'Choose who to call.' : 'Add at least one recipient.');
    const max = wa ? 10 : MAX_RECIPIENTS;
    if (list.length > max) return setErr(`At most ${max} recipients per ${wa ? 'WhatsApp reminder' : 'text'}.`);
    const bad = list.find((r) => !validNumber(r.number));
    if (bad) return setErr(`"${bad.number}" is not a valid number.`);
    if (wa) {
      const local = list.find((r) => !normalizeNumber(r.number).startsWith('+'));
      if (local) return setErr(`WhatsApp needs the country code, e.g. +255712345678 (${local.number}).`);
    }
    if (type === 'text' && !message.trim()) return setErr('Write the message to send.');
    if (!when.includes('T')) return setErr('Pick a time as well as a date.');
    const at = parseLocal(when);
    if (repeat === 'none' && at.getTime() <= Date.now() + 30000) return setErr('Pick a time in the future.');
    onSave({
      recipients: list, name: list[0].name || '', number: list.map((r) => r.number).join(', '),
      type, channel: type === 'text' ? channel : 'sms', message: type === 'call' ? '' : message.trim(), at: when, repeat,
      sim: type === 'text' && channel === 'sms' ? sim : null,
    });
  };

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={[s.modalWrap, { paddingBottom: kb }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={s.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: Math.max(220, winH - kb - 160) }}>
            <Text style={s.sheetTitle}>{isNew ? 'Schedule' : 'Edit'} {type === 'call' ? 'a call' : 'a text'}</Text>
            {isNew && (
              <View style={[s.seg, { marginBottom: 14 }]}>
                {[['text', 'Text'], ['call', 'Call']].map(([v, l]) => (
                  <Pressable key={v} style={[s.segItem, type === v && s.segActive]}
                    onPress={() => { setType(v); setErr(''); if (v === 'call') setRecipients((cur) => cur.slice(0, 1)); }}>
                    <Text style={[s.segText, type === v && { color: T.onPrimary, fontWeight: '700' }]}>{l}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {type === 'text' && (
              <View style={[s.seg, { marginBottom: 14 }]}>
                {[['sms', 'SMS (sends itself)'], ['whatsapp', 'WhatsApp (reminder)']].map(([v, l]) => (
                  <Pressable key={v} style={[s.segItem, channel === v && s.segActive]} onPress={() => { setChannel(v); setErr(''); }}>
                    <Text style={[s.segText, channel === v && { color: T.onPrimary, fontWeight: '700' }]} numberOfLines={1}>{l}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {type === 'text' && channel === 'whatsapp' && (
              <Text style={[s.muted, { marginTop: -6, marginBottom: 14 }]}>
                WhatsApp can't be sent for you. At this time you get a notification; tap it to open the chat with your message ready, then press send.
              </Text>
            )}

            <Text style={s.label}>To{recipients.length > 1 ? ` (${recipients.length} people)` : ''}</Text>
            {recipients.length > 0 && (
              <View style={[s.dtRow, { marginBottom: 10 }]}>
                {recipients.map((r) => (
                  <Pressable key={r.number} style={[s.dtChip, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}
                    onPress={() => setRecipients((cur) => cur.filter((x) => x.number !== r.number))}>
                    <Text style={s.dtText}>{r.name || r.number}</Text>
                    <Ionicons name="close" size={16} color={T.muted} />
                  </Pressable>
                ))}
              </View>
            )}
            <View style={[s.keyRow, { marginBottom: 14 }]}>
              <TextInput style={[s.field, s.flex1, { marginBottom: 0 }]} value={typed}
                onChangeText={(v) => { setTyped(v); setErr(''); }} onSubmitEditing={addTyped}
                placeholder="Type a number" keyboardType="phone-pad" placeholderTextColor={T.muted} />
              <Pressable style={[s.micBtn, !typed.trim() && { opacity: 0.4 }]} onPress={addTyped} disabled={!typed.trim()} accessibilityLabel="Add number">
                <Ionicons name="add" size={24} color={T.text} />
              </Pressable>
              <Pressable style={s.micBtn} onPress={() => setPicking(true)} accessibilityLabel="Choose from contacts">
                <Ionicons name="people-outline" size={22} color={T.text} />
              </Pressable>
            </View>
            {picking && <ContactPicker T={T} multi onClose={() => setPicking(false)} onDone={(list) => { setPicking(false); addRecipients(list); }} />}

            {type === 'text' && (
              <>
                <Text style={s.label}>Message</Text>
                <TextInput style={[s.field, { minHeight: 110, textAlignVertical: 'top' }]} value={message}
                  onChangeText={(v) => { setMessage(v); setErr(''); }} multiline placeholder="What should it say?"
                  placeholderTextColor={T.muted} />
              </>
            )}

            <Text style={s.label}>{type === 'call' ? 'Call at' : channel === 'whatsapp' ? 'Remind me at' : 'Send at'}</Text>
            <DateTimeField s={s} T={T} value={when} onChange={(v) => { setWhen(v); setErr(''); }} />

            <Text style={s.label}>Repeat</Text>
            <View style={[s.seg, { marginBottom: 14 }]}>
              {REPEATS.map((r) => (
                <Pressable key={r} style={[s.segItem, repeat === r && s.segActive]} onPress={() => setRepeat(r)}>
                  <Text style={[s.segText, repeat === r && { color: T.onPrimary, fontWeight: '700' }]}>{REPEAT_LABEL[r]}</Text>
                </Pressable>
              ))}
            </View>

            {nativeAvailable && type === 'text' && channel === 'sms' && (
              <>
                <Text style={s.label}>Send from</Text>
                {sims === null ? (
                  <Pressable style={[s.dtChip, { alignSelf: 'flex-start', marginBottom: 14 }]} onPress={loadSims}>
                    <Text style={s.dtText}>{sim ? `SIM ${sim.slot}` : 'Phone default'}  ·  Choose SIM…</Text>
                  </Pressable>
                ) : (
                  <View style={[s.seg, { marginBottom: 14 }]}>
                    {[{ subId: null, slot: 0, name: 'Default' }, ...sims].map((x) => {
                      const on = (sim ? sim.subId : null) === x.subId;
                      return (
                        <Pressable key={String(x.subId)} style={[s.segItem, on && s.segActive]}
                          onPress={() => setSim(x.subId == null ? null : { subId: x.subId, slot: x.slot })}>
                          <Text style={[s.segText, on && { color: T.onPrimary, fontWeight: '700' }]} numberOfLines={1}>
                            {x.subId == null ? 'Default' : `SIM ${x.slot}${x.carrier ? ' · ' + x.carrier : ''}`}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </>
            )}
            {err ? <Text style={{ color: T.danger, marginBottom: 10 }}>{err}</Text> : null}
          </ScrollView>
          <View style={s.sheetBtns}>
            <Pressable style={s.ghostBtn} onPress={onClose}><Text style={{ color: T.text, fontWeight: '600' }}>Cancel</Text></Pressable>
            <Pressable style={[s.primaryBtn, s.flex1]} onPress={save}><Text style={{ color: T.onPrimary, fontWeight: '700' }}>{isNew ? (type === 'call' ? 'Schedule call' : 'Schedule') : 'Save'}</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function DateTimeField({ s, T, value, onChange, optional }) {
  const date = parseLocal(value);
  const hasTime = !!value && value.includes('T');
  const base = date || new Date();
  const ios = Platform.OS === 'ios';
  const theme = T.bg === '#0E1015' ? 'dark' : 'light';

  const combine = (d, t) => toStored(new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.getHours(), t.getMinutes()), true);
  const setDatePart = (d) => onChange(hasTime ? combine(d, base) : toStored(d, false));
  const setTimePart = (t) => onChange(combine(base, t));
  const defaultTime = () => { const n = new Date(); n.setMinutes(0, 0, 0); n.setHours(n.getHours() + 1); return n; };

  const openAndroid = (mode) =>
    DateTimePickerAndroid.open({
      value: mode === 'time' && !hasTime ? defaultTime() : base, mode, is24Hour: true,
      onChange: (e, d) => { if (e.type === 'set' && d) (mode === 'date' ? setDatePart : setTimePart)(d); },
    });

  const dateLabel = date ? date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Pick a date';
  const timeLabel = hasTime ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : null;

  return (
    <View style={{ marginBottom: 14 }}>
      <View style={s.dtRow}>
        {ios && date ? (
          <DateTimePicker value={base} mode="date" display="compact" themeVariant={theme} onChange={(_, d) => d && setDatePart(d)} />
        ) : (
          <Pressable style={s.dtChip} onPress={() => (ios ? onChange(toStored(new Date(), false)) : openAndroid('date'))}>
            <Text style={s.dtText}>📅 {dateLabel}</Text>
          </Pressable>
        )}
        {date && (ios && hasTime ? (
          <DateTimePicker value={base} mode="time" display="compact" is24Hour themeVariant={theme} onChange={(_, d) => d && setTimePart(d)} />
        ) : (
          <Pressable style={s.dtChip} onPress={() => (ios ? setTimePart(defaultTime()) : openAndroid('time'))}>
            <Text style={s.dtText}>🕒 {timeLabel || 'Add time'}</Text>
          </Pressable>
        ))}
      </View>
      {date && (hasTime || optional) && (
        <View style={[s.dtRow, { marginTop: 8 }]}>
          {hasTime && <Pressable onPress={() => onChange(toStored(date, false))}><Text style={{ color: T.muted, fontSize: 13 }}>Remove time</Text></Pressable>}
          {optional && <Pressable onPress={() => onChange('')}><Text style={{ color: T.danger, fontSize: 13 }}>Clear date</Text></Pressable>}
        </View>
      )}
    </View>
  );
}

function TimeField({ s, T, value, onChange }) {
  const [h, m] = (value || '08:00').split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  const set = (x) => onChange(`${pad(x.getHours())}:${pad(x.getMinutes())}`);
  if (Platform.OS === 'ios') {
    return <DateTimePicker value={d} mode="time" display="compact" is24Hour themeVariant={T.bg === '#0E1015' ? 'dark' : 'light'} onChange={(_, x) => x && set(x)} />;
  }
  return (
    <Pressable style={s.dtChip} onPress={() => DateTimePickerAndroid.open({ value: d, mode: 'time', is24Hour: true, onChange: (e, x) => { if (e.type === 'set' && x) set(x); } })}>
      <Text style={s.dtText}>🕒 {pad(h)}:{pad(m)}</Text>
    </Pressable>
  );
}

function EditSheet({ s, T, kind, item, isNew, onSave, onClose }) {
  const kb = useKeyboardHeight();
  const { height: winH } = useWindowDimensions();
  const [title, setTitle] = useState(item.title ?? '');
  const [body, setBody] = useState(item.text ?? '');
  const [when, setWhen] = useState((kind === 'task' ? item.due : item.start) || '');
  const [loc, setLoc] = useState(item.location || '');
  const [repeat, setRepeat] = useState(item.repeat || 'none');
  const [err, setErr] = useState('');

  const save = () => {
    if (kind === 'note') {
      if (!title.trim() && !body.trim()) return setErr('Write something first.');
      return onSave({ title: title.trim(), text: body.trim() });
    }
    if (!title.trim()) return setErr('Title is required.');
    if (kind === 'event') {
      if (!when) return setErr('Events need a start date.');
      return onSave({ title: title.trim(), start: when, location: loc.trim(), repeat });
    }
    if (repeat !== 'none' && !when) return setErr('Pick a due date to repeat this task.');
    onSave({ title: title.trim(), due: when || null, repeat: when ? repeat : 'none' });
  };

  const clear = () => setErr('');

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={[s.modalWrap, { paddingBottom: kb }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={s.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: Math.max(220, winH - kb - 160) }}>
            <Text style={s.sheetTitle}>{isNew ? 'New' : 'Edit'} {kind === 'note' ? 'note' : kind}</Text>
            <Text style={s.label}>{kind === 'note' ? 'Title (optional)' : 'Title'}</Text>
            <TextInput
              style={s.field} value={title} onChangeText={(v) => { setTitle(v); clear(); }}
              placeholder={kind === 'task' ? 'What needs doing?' : kind === 'event' ? 'What is happening?' : 'Note title'}
              placeholderTextColor={T.muted} autoFocus={isNew && kind !== 'note'}
            />
            {kind === 'note' && (
              <>
                <Text style={s.label}>Note</Text>
                <TextInput
                  style={[s.field, { minHeight: 180, textAlignVertical: 'top' }]} value={body}
                  onChangeText={(v) => { setBody(v); clear(); }} multiline placeholder="Start writing…"
                  placeholderTextColor={T.muted} autoFocus={isNew}
                />
              </>
            )}
            {kind !== 'note' && (
              <>
                <Text style={s.label}>{kind === 'task' ? 'Due (optional)' : 'Starts'}</Text>
                {isNew && kind === 'event' && !when && (
                  <Pressable style={[s.dtChip, { alignSelf: 'flex-start', marginBottom: 14 }]} onPress={() => setWhen(toStored(new Date(), true))}>
                    <Text style={s.dtText}>Set date and time</Text>
                  </Pressable>
                )}
                {(!(isNew && kind === 'event' && !when)) && (
                  <DateTimeField s={s} T={T} value={when} onChange={(v) => { setWhen(v); clear(); }} optional={kind === 'task'} />
                )}
                <Text style={s.label}>Repeat</Text>
                <View style={[s.seg, { marginBottom: 14 }]}>
                  {REPEATS.map((r) => (
                    <Pressable key={r} style={[s.segItem, repeat === r && s.segActive]} onPress={() => setRepeat(r)}>
                      <Text style={[s.segText, repeat === r && { color: T.onPrimary, fontWeight: '700' }]}>{REPEAT_LABEL[r]}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            {kind === 'event' && (
              <>
                <Text style={s.label}>Location (optional)</Text>
                <TextInput style={s.field} value={loc} onChangeText={setLoc} placeholderTextColor={T.muted} />
              </>
            )}
            {err ? <Text style={{ color: T.danger, marginBottom: 10 }}>{err}</Text> : null}
          </ScrollView>
          <View style={s.sheetBtns}>
            <Pressable style={s.ghostBtn} onPress={onClose}><Text style={{ color: T.text, fontWeight: '600' }}>Cancel</Text></Pressable>
            <Pressable style={[s.primaryBtn, s.flex1]} onPress={save}><Text style={{ color: T.onPrimary, fontWeight: '700' }}>{isNew ? 'Add' : 'Save'}</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const Empty = ({ s, icon, text }) => (
  <View style={s.emptyBox}><Text style={{ fontSize: 34 }}>{icon}</Text><Text style={[s.muted, { textAlign: 'center', marginTop: 8, fontSize: 14 }]}>{text}</Text></View>
);

// ---------- settings ----------
function Settings({ s, T, apiKey, name, assistant, prefs, changePrefs, onSave }) {
  const [k, setK] = useState(apiKey);
  const [n, setN] = useState(name);
  const [a, setA] = useState(assistant);
  const [show, setShow] = useState(false);

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <View style={s.panel}>
        <Text style={s.label}>Assistant name</Text>
        <TextInput style={s.field} value={a} onChangeText={setA} placeholder={`Default: ${DEFAULT_ASSISTANT}`} placeholderTextColor={T.muted} />
        <Text style={s.label}>Your name</Text>
        <TextInput style={s.field} value={n} onChangeText={setN} placeholder="What should your assistant call you?" placeholderTextColor={T.muted} />
      </View>

      <View style={s.panel}>
        <Text style={s.label}>Appearance</Text>
        <View style={[s.seg, { marginBottom: 0 }]}>
          {[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => (
            <Pressable key={v} style={[s.segItem, prefs.theme === v && s.segActive]} onPress={() => changePrefs({ theme: v })}>
              <Text style={[s.segText, prefs.theme === v && { color: T.onPrimary, fontWeight: '700' }]}>{l}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={s.panel}>
        <View style={s.keyRow}>
          <View style={s.flex1}>
            <Text style={[s.label, { marginBottom: 2 }]}>Reminders</Text>
            <Text style={[s.muted, { marginTop: 0 }]}>Notify me when tasks are due and 10 min before events. Date-only items remind at 9:00.</Text>
          </View>
          <Switch value={prefs.reminders} onValueChange={(v) => changePrefs({ reminders: v })} trackColor={{ true: T.primary }} />
        </View>
        <View style={[s.keyRow, { marginTop: 16 }]}>
          <View style={s.flex1}>
            <Text style={[s.label, { marginBottom: 2 }]}>Morning briefing</Text>
            <Text style={[s.muted, { marginTop: 0 }]}>A daily notification summarising your day. Tap it to get Jolly's full briefing.</Text>
          </View>
          <Switch value={prefs.briefing} onValueChange={(v) => changePrefs({ briefing: v })} trackColor={{ true: T.primary }} />
        </View>
        {prefs.briefing && (
          <View style={[s.keyRow, { marginTop: 10 }]}>
            <Text style={[s.muted, s.flex1, { marginTop: 0 }]}>Deliver at</Text>
            <TimeField s={s} T={T} value={prefs.briefingTime} onChange={(v) => changePrefs({ briefingTime: v })} />
          </View>
        )}
        <Text style={[s.muted, { marginTop: 10 }]}>
          Voice input: {voiceAvailable ? 'enabled (mic button in chat).' : 'needs a development build. In Expo Go, use the microphone on your keyboard.'}
        </Text>
      </View>

      <View style={s.panel}>
        <Text style={s.label}>Claude API key</Text>
        <View style={s.keyRow}>
          <TextInput style={[s.field, s.flex1, { marginBottom: 0 }]} value={k} onChangeText={setK} placeholder="sk-ant-…"
            placeholderTextColor={T.muted} secureTextEntry={!show} autoCapitalize="none" autoCorrect={false} />
          <Pressable onPress={() => setShow(!show)} style={s.showBtn}><Text style={{ color: T.primary, fontWeight: '600' }}>{show ? 'Hide' : 'Show'}</Text></Pressable>
        </View>
        <Text style={[s.muted, { marginTop: 8 }]}>Stored encrypted on this device only. Create one at console.anthropic.com.</Text>
      </View>

      <Pressable style={[s.primaryBtn, !k.trim() && { opacity: 0.5 }]} disabled={!k.trim()} onPress={() => onSave(k.trim(), n.trim(), a.trim())}>
        <Text style={{ color: T.onPrimary, fontWeight: '700', fontSize: 16 }}>Save</Text>
      </Pressable>
    </ScrollView>
  );
}

// ---------- styles ----------
const makeStyles = (T) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: T.bg },
    flex1: { flex: 1 },
    center: { alignItems: 'center', justifyContent: 'center' },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: T.card, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: T.border },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' },
    avatarText: { color: T.onPrimary, fontWeight: '800', fontSize: 18 },
    title: { fontSize: 17, fontWeight: '700', color: T.text },
    subtitle: { fontSize: 12, color: T.muted },
    navWrap: { backgroundColor: T.bg, paddingHorizontal: 16, paddingTop: 6 },
    navBar: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: T.card,
      borderRadius: 32, padding: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: T.border,
      shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 8,
    },
    navItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, minWidth: 56, paddingHorizontal: 16, borderRadius: 26 },
    navItemActive: { backgroundColor: T.primarySoft, flexGrow: 1.4 },
    navLabel: { color: T.primary, fontWeight: '700', fontSize: 14 },
    navBadge: { position: 'absolute', top: -5, right: -9, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: T.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
    tabs: { flexDirection: 'row', backgroundColor: T.card, borderTopWidth: StyleSheet.hairlineWidth, borderColor: T.border, paddingTop: 6 },
    tab: { flex: 1, alignItems: 'center', gap: 2 },
    tabPill: { paddingHorizontal: 18, paddingVertical: 4, borderRadius: 14 },
    tabText: { fontSize: 11, color: T.muted },
    badge: { position: 'absolute', top: -2, right: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: T.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
    badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
    banner: { flexDirection: 'row', backgroundColor: T.warnSoft, padding: 12 },
    row: { marginVertical: 3 },
    bubble: { maxWidth: '84%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
    userB: { backgroundColor: T.primary, borderBottomRightRadius: 5 },
    botB: { alignSelf: 'flex-start', backgroundColor: T.botBubble, borderWidth: StyleSheet.hairlineWidth, borderColor: T.border, borderBottomLeftRadius: 5 },
    errB: { alignSelf: 'flex-start', backgroundColor: T.dangerSoft, borderBottomLeftRadius: 5 },
    time: { fontSize: 10.5, color: T.muted, marginTop: 2, marginHorizontal: 6 },
    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 40, gap: 10 },
    hello: { fontSize: 24, fontWeight: '800', color: T.text, marginTop: 6 },
    helloSub: { fontSize: 15, color: T.muted, textAlign: 'center', lineHeight: 21 },
    chips: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
    chip: { backgroundColor: T.primarySoft, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18 },
    chipText: { color: T.primary, fontWeight: '600', fontSize: 13.5 },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, backgroundColor: T.card, borderTopWidth: StyleSheet.hairlineWidth, borderColor: T.border },
    input: { flex: 1, backgroundColor: T.bg, color: T.text, borderRadius: 20, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10, maxHeight: 120, fontSize: 15.5 },
    micBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: T.border, alignItems: 'center', justifyContent: 'center' },
    dtRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    dtChip: { backgroundColor: T.bg, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11 },
    dtText: { color: T.text, fontSize: 15 },
    briefBtn: { backgroundColor: T.primarySoft, borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginBottom: 12 },
    fab: { position: 'absolute', right: 18, bottom: 16, width: 58, height: 58, borderRadius: 29, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
    modalWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: { backgroundColor: T.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 32 },
    sheetTitle: { fontSize: 18, fontWeight: '800', color: T.text, marginBottom: 14 },
    sheetBtns: { flexDirection: 'row', gap: 10, marginTop: 4 },
    ghostBtn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: T.border },
    sendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' },
    sendIcon: { color: T.onPrimary, fontSize: 22, fontWeight: '800', marginTop: -2 },
    stats: { flexDirection: 'row', gap: 10, marginBottom: 14 },
    stat: { flex: 1, backgroundColor: T.card, borderRadius: 14, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: T.border },
    statNum: { fontSize: 24, fontWeight: '800', color: T.primary },
    seg: { flexDirection: 'row', backgroundColor: T.card, borderRadius: 12, padding: 3, marginBottom: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: T.border },
    segItem: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 9 },
    segActive: { backgroundColor: T.primary },
    segText: { color: T.muted, fontWeight: '600' },
    addRow: { flexDirection: 'row', gap: 8, marginBottom: 12, alignItems: 'center' },
    card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: T.card, padding: 14, borderRadius: 14, marginBottom: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: T.border },
    cardTitle: { fontSize: 15.5, fontWeight: '600', color: T.text },
    muted: { color: T.muted, fontSize: 12.5, marginTop: 2 },
    check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: T.muted, alignItems: 'center', justifyContent: 'center' },
    section: { fontSize: 12, fontWeight: '700', color: T.muted, textTransform: 'uppercase', marginTop: 10, marginBottom: 6 },
    emptyBox: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 },
    panel: { backgroundColor: T.card, borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: T.border },
    label: { fontSize: 13, fontWeight: '700', color: T.muted, marginBottom: 6 },
    field: { backgroundColor: T.bg, color: T.text, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 14, fontSize: 15.5 },
    keyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    showBtn: { paddingHorizontal: 8, paddingVertical: 10 },
    primaryBtn: { backgroundColor: T.primary, borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  });
