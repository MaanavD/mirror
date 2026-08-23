import calendarModule from './calendar.js';
import nanoleafModule from './nanoleaf.js';
import newsModule from './news.js';
import notionModule from './notion.js';
import quoteModule from './quote.js';
import spotifyModule from './spotify.js';
import weatherModule from './weather.js';

/**
 * Registration order = order of the keys in /api/state.modules.
 * To add a module see DESIGN.md ("adding a module").
 */
export const modules = [weatherModule, calendarModule, quoteModule, notionModule, nanoleafModule, spotifyModule, newsModule];

export default modules;
