import astroModule from './astro.js';
import aqiModule from './aqi.js';
import calendarModule from './calendar.js';
import countdownModule from './countdown.js';
import hermyModule from './hermy.js';
import leavebyModule from './leaveby.js';
import nanoleafModule from './nanoleaf.js';
import newsModule from './news.js';
import notionModule from './notion.js';
import quoteModule from './quote.js';
import spotifyModule from './spotify.js';
import weatherModule from './weather.js';
import wellnessModule from './wellness.js';
import workboardModule from './workboard.js';
import agentsModule from './agents.js';
import progressModule from './progress.js';

/**
 * Registration order = order of the keys in /api/state.modules.
 * To add a module see DESIGN.md ("Adding a module").
 */
export const modules = [
  weatherModule,
  astroModule,
  aqiModule,
  calendarModule,
  countdownModule,
  hermyModule,
  leavebyModule,
  wellnessModule,
  quoteModule,
  notionModule,
  workboardModule,
  agentsModule,
  progressModule,
  nanoleafModule,
  spotifyModule,
  newsModule,
];

export default modules;
