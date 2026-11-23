import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Contacts from 'expo-contacts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const digits = (n) => (n || '').replace(/[\s\-().]/g, '');

/**
 * In-app contact list. Used instead of the system picker, which some phones can't open.
 * multi=true lets you tick several people (bulk); otherwise tapping a row chooses it.
 * onDone receives [{ name, number }].
 */
export function ContactPicker({ T, multi, onDone, onClose }) {
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState({});
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const perm = await Contacts.requestPermissionsAsync();
        if (!perm.granted) {
          setErr('Contacts permission was denied. Allow it in app settings, or type the number yourself.');
          return setRows([]);
        }
        const all = await Contacts.Contact.getAllDetails(['fullName', 'phones']);
        const seen = new Set();
        const flat = [];
        for (const c of all) {
          for (const p of c.phones || []) {
            if (!p.number) continue;
            const key = digits(p.number);
            if (seen.has(key + '|' + (c.fullName || ''))) continue;
            seen.add(key + '|' + (c.fullName || ''));
            flat.push({ key: key + '|' + flat.length, name: c.fullName || '', number: p.number, label: p.label || '' });
          }
        }
        flat.sort((a, b) => (a.name || '~').localeCompare(b.name || '~'));
        setRows(flat);
      } catch (e) {
        setErr(e?.message || 'Could not read contacts.');
        setRows([]);
      }
    })();
  }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!rows) return [];
    return t ? rows.filter((r) => r.name.toLowerCase().includes(t) || digits(r.number).includes(digits(t) || '§')) : rows;
  }, [rows, q]);

  const count = Object.keys(sel).length;
  const toggle = (r) =>
    setSel((s) => {
      const n = { ...s };
      if (n[r.key]) delete n[r.key]; else n[r.key] = r;
      return n;
    });

  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: T.bg, paddingTop: insets.top }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: T.card }}>
          <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={26} color={T.text} /></Pressable>
          <Text style={{ flex: 1, color: T.text, fontSize: 18, fontWeight: '700' }}>{multi ? 'Choose people' : 'Choose a contact'}</Text>
          {multi && (
            <Pressable onPress={() => onDone(Object.values(sel).map(({ name, number }) => ({ name, number })))} disabled={!count}
              style={{ backgroundColor: T.primary, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8, opacity: count ? 1 : 0.4 }}>
              <Text style={{ color: T.onPrimary, fontWeight: '700' }}>Done{count ? ` (${count})` : ''}</Text>
            </Pressable>
          )}
        </View>
        <View style={{ padding: 12 }}>
          <TextInput
            value={q} onChangeText={setQ} placeholder="Search name or number" placeholderTextColor={T.muted}
            style={{ backgroundColor: T.card, color: T.text, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 11, fontSize: 15.5 }}
          />
        </View>
        {rows === null ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={T.primary} />
        ) : (
          <FlatList
            data={shown}
            keyExtractor={(r) => r.key}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
            ListEmptyComponent={<Text style={{ color: err ? T.danger : T.muted, textAlign: 'center', margin: 30 }}>{err || 'No contacts with phone numbers found.'}</Text>}
            renderItem={({ item }) => {
              const on = !!sel[item.key];
              return (
                <Pressable
                  onPress={() => (multi ? toggle(item) : onDone([{ name: item.name, number: item.number }]))}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}
                >
                  {multi && <Ionicons name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? T.primary : T.muted} />}
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: T.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>{item.name || item.number}</Text>
                    <Text style={{ color: T.muted, fontSize: 13 }}>{item.name ? item.number : ''}{item.label ? `  ·  ${item.label}` : ''}</Text>
                  </View>
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}
