import astroModule from './astro.js';
import aqiModule from './aqi.js';
import calendarModule from './calendar.js';
import chipdropModule from './chipdrop.js';
import countdownModule from './countdown.js';
import focusModule from './focus.js';
import hermyModule from './hermy.js';
import leavebyModule from './leaveby.js';
import mysteryModule from './mystery.js';
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
export const modules = [
  weatherModule,
  astroModule,
  aqiModule,
  calendarModule,
  chipdropModule,
  countdownModule,
  focusModule,
  hermyModule,
  leavebyModule,
  mysteryModule,
  quoteModule,
  notionModule,
  nanoleafModule,
  spotifyModule,
  newsModule,
];

export default modules;
