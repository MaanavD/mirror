import astroModule from './astro.js';
import calendarModule from './calendar.js';
import leavebyModule from './leaveby.js';
import nanoleafModule from './nanoleaf.js';
import notionModule from './notion.js';
import quoteModule from './quote.js';
import spotifyModule from './spotify.js';
import weatherModule from './weather.js';

/**
 * Registration order = order of the keys in /api/state.modules.
 * To add a module see DESIGN.md ("adding a module").
 */
export const modules = [weatherModule, astroModule, calendarModule, quoteModule, notionModule, nanoleafModule, spotifyModule];
export const modules = [weatherModule, calendarModule, leavebyModule, quoteModule, notionModule, nanoleafModule, spotifyModule];

export default modules;
