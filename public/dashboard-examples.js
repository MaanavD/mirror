// Explicitly selected preview scenarios. Never mixed into the live feed.
export function exampleState(kind, now) {
  if(['day','agents','weekend'].includes(kind))now=Date.parse(new Date(now).toISOString().slice(0,10)+'T18:00:00Z');
  if(kind==='weekend')now-=new Date(now).getUTCDay()*86400000;
  const minute=60000,iso=t=>new Date(t).toISOString();
  const module=data=>({data,stale:false,fetchedAt:now});
  const event=(id,title,inMin,duration,location)=>({id,title,start:iso(now+inMin*minute),end:iso(now+(inMin+duration)*minute),allDay:false,location});
  const next=event('example-review','Design review',8,45,'Video call');
  const later=event('example-dinner','Dinner with friends',180,90,'Capitol Hill');
  const s={generatedAt:iso(now),display:{on:true},modules:{
    calendar:module({configured:true,timeZone:'America/Los_Angeles',today:[next,later],tomorrow:[]}),
    weather:module({current:{temp:18,code:2,text:'Partly cloudy'},today:{hi:20,lo:12},rain:{rainAtISO:iso(now+42*minute)},hours:[0,1,2,3,4].map((v)=>({at:iso(now+v*60*minute),temp:18-v,code:v>1?61:2}))}),
    astro:module({sunsetAt:iso(now+105*minute),uvHours:[-30,30,90].map((v,i)=>({at:iso(now+v*minute),uv:[3.9,2.9,1.5][i]}))}),
    notion:module({configured:true,total:3,items:[{id:'example-a',title:'Prepare notes for the review'},{id:'example-b',title:'Pick up a package'},{id:'example-c',title:'Plan the weekend'}]}),
    countdown:module({items:[{kind:'flight',label:'TORONTO',days:18},{kind:'milestone',label:'SF MOVE',days:40}]}),
    wellness:{data:{score:88,hrv:47},stale:true,fetchedAt:now-12*86400000}
  }};
  if(['day','agents','weekend'].includes(kind)){
    s.exampleNow=now;
    s.modules.calendar.data.today=[event('e1','Project review',-100,45,'Video call'),event('e2','Team sync',95,30,'Video call'),event('e3','Dinner',420,90,'')];
    s.modules.weather.data.rain=null;
    s.modules.astro.data.sunsetAt=iso(now+520*minute);
    s.modules.wellness=module({dayWindow:{wakeAt:iso(now-180*minute),bedtimeAt:iso(now+720*minute),wakeSource:'eight_sleep',bedtimeSource:'estimated',estimated:true}});
    s.modules.notion=module({configured:true,items:[{id:'personal1',title:'Book the appointment',status:'In progress',source:'personal'}]});
    s.modules.workboard=module({configured:true,items:[{id:'work1',title:'Review the new demo samples',status:'Review',source:'work',effortMinutes:15}]});
    s.modules.agents=module({connected:true,items:[{id:'a',name:'Hermes',task:'Preparing the demo comparison',status:'running',live:true},{id:'b',name:'Luna',task:'Checking the documentation links',status:'running',live:true}]});
    s.modules.progress=module({weekCount:3,baselineDone:18,trackingSince:iso(now-3*86400000),timeZone:'America/Los_Angeles',items:[{title:'Published the example project'},{title:'Finished the trip planning'}]});
    s.modules.quote=module({text:'You don’t have to do it all at once. Give the next small thing your attention, and let that be enough for this moment.',author:'Hermy'});
    s.modules.spotify=module({configured:true,isPlaying:true,track:{name:'A quiet morning',artists:['Example track']},progressMs:74000,durationMs:210000});
  }
  if(kind==='agents')s.modules.agents.data.items=[
    {id:'a',name:'Hermes',task:'Preparing the demo comparison',status:'running',live:true},
    {id:'b',name:'Luna',task:'Checking documentation links',status:'running',live:true},
    {id:'c',name:'Scout',task:'Collecting the research sources',status:'running',live:true},
    {id:'d',name:'Builder',task:'Building the calendar integration',status:'running',live:true},
    {id:'e',name:'Reviewer',task:'Checking the latest changes',status:'running',live:true},
    {id:'f',name:'Atlas',task:'Waiting for your review of the draft',status:'waiting',live:false},
  ];
  if(kind==='weekend'){
    s.modules.calendar.data.today=[event('workout','Workout: Recovery Mobility',420,45,'')];
    s.modules.calendar.data.tomorrow=[];
    s.modules.agents.data.items=[];
    s.modules.spotify.data.isPlaying=false;
  }
  if(kind==='leave'){
    next.title='Dinner with friends';next.start=iso(now+32*minute);next.end=iso(now+120*minute);next.location='Capitol Hill';
    s.modules.calendar.data.today=[next];
    s.modules.leaveby=module({eventTitle:next.title,leaveByMs:now+2*minute,driveMin:22,location:next.location});
  }
  if(kind==='sunset'){s.modules.calendar.data.today=[];s.modules.weather.data.rain=null;s.modules.astro.data={sunsetAt:iso(now+35*minute),uvHours:[]};}
  if(kind==='quiet'){s.modules.calendar.data.today=[];s.modules.weather.data.rain=null;}
  if(kind==='stale')for(const entry of Object.values(s.modules)){entry.fetchedAt=now-2*86400000;entry.stale=true;}
  return s;
}
