import { loadData } from '../storage';
import { renderAgendaWidget } from './AgendaWidget';

// Runs headless when Android asks the widget to draw (added, resized, periodic refresh).
export async function widgetTaskHandler(props) {
  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED':
      props.renderWidget(renderAgendaWidget(await loadData(), props.widgetInfo));
      break;
    default:
      break;
  }
}
