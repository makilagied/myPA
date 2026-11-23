import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { nextOccurrence, pad, parseLocal, startOfDay } from '../dates';

const COLORS = {
  light: { bg: '#FFFFFF', text: '#111827', muted: '#6B7280', primary: '#5B4DF0', onPrimary: '#FFFFFF', danger: '#DC2626' },
  dark: { bg: '#181B22', text: '#F3F4F6', muted: '#9CA3AF', primary: '#8B7FFF', onPrimary: '#0E1015', danger: '#F87171' },
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function dayLabel(d, now) {
  if (sameDay(d, now)) return 'today';
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return sameDay(d, tomorrow) ? 'tomorrow' : WEEKDAY[d.getDay()];
}

/** Plain rows for the widget: upcoming events first, then open tasks (overdue first). */
export function buildWidgetRows(data, max, now = new Date()) {
  const sod = startOfDay(now);
  const horizon = new Date(sod.getFullYear(), sod.getMonth(), sod.getDate() + 3);

  const events = data.events
    .map((e) => ({ e, at: nextOccurrence(e.start, e.repeat, sod) }))
    .filter(({ e, at }) => at && at < horizon && (e.start.includes('T') ? at.getTime() >= now.getTime() - 30 * 60000 : true))
    .sort((a, b) => a.at - b.at)
    .map(({ e, at }) => {
      const when = e.start.includes('T') ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : 'all day';
      const day = sameDay(at, now) ? '' : `${dayLabel(at, now)} `;
      return { text: `🗓 ${day}${when} · ${e.title}`, alert: false };
    });

  const tasks = data.tasks
    .filter((t) => !t.done)
    .map((t) => ({ t, due: t.due ? parseLocal(t.due) : null }))
    .sort((a, b) => (a.due ? a.due.getTime() : Infinity) - (b.due ? b.due.getTime() : Infinity))
    .map(({ t, due }) => {
      const overdue = due && due < sod;
      const tag = due ? ` · ${overdue ? 'overdue' : dayLabel(due, now)}` : '';
      return { text: `☐ ${t.title}${tag}`, alert: !!overdue };
    });

  const rows = [...events, ...tasks];
  if (!rows.length) return [{ text: 'All clear ✓ Nothing planned', alert: false }];
  if (rows.length > max) {
    const hidden = rows.length - (max - 1);
    return [...rows.slice(0, Math.max(1, max - 1)), { text: `+${hidden} more`, alert: false, muted: true }];
  }
  return rows;
}

export function AgendaWidget({ rows, theme = 'light', dateLabel }) {
  const C = COLORS[theme];
  return (
    <FlexWidget
      clickAction="OPEN_APP"
      style={{ height: 'match_parent', width: 'match_parent', backgroundColor: C.bg, borderRadius: 22, padding: 14, flexDirection: 'column' }}
    >
      <FlexWidget style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: 'match_parent', marginBottom: 8 }}>
        <FlexWidget style={{ flexDirection: 'column' }}>
          <TextWidget text="myPA" style={{ fontSize: 16, fontWeight: 'bold', color: C.primary }} />
          <TextWidget text={dateLabel} style={{ fontSize: 11, color: C.muted }} />
        </FlexWidget>
        <FlexWidget
          clickAction="OPEN_URI"
          clickActionData={{ uri: 'mypa://add/task' }}
          accessibilityLabel="Add task"
          style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.primary, justifyContent: 'center', alignItems: 'center' }}
        >
          <TextWidget text="+" style={{ fontSize: 22, fontWeight: 'bold', color: C.onPrimary }} />
        </FlexWidget>
      </FlexWidget>
      {rows.map((r, i) => (
        <TextWidget
          key={i}
          text={r.text}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 13, color: r.alert ? C.danger : r.muted ? C.muted : C.text, marginBottom: 5 }}
        />
      ))}
    </FlexWidget>
  );
}

/** Reads saved data and returns light+dark renderings sized for the given widget. */
export function renderAgendaWidget(data, info) {
  const now = new Date();
  const height = info?.height || 140;
  const max = Math.max(2, Math.floor((height - 64) / 24));
  const rows = buildWidgetRows(data, max, now);
  const dateLabel = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  return {
    light: <AgendaWidget rows={rows} theme="light" dateLabel={dateLabel} />,
    dark: <AgendaWidget rows={rows} theme="dark" dateLabel={dateLabel} />,
  };
}
