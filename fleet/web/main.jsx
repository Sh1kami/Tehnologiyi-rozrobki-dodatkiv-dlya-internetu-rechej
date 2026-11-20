import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {io} from 'socket.io-client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import {vehicleStatus,zone} from '../src/domain.js';

const statuses={normal:'Норма',warning:'Увага',critical:'Мало пального',speed:'Перевищення',outside:'Поза геозоною',offline:'Немає GPS'};
const fmt=new Intl.NumberFormat('uk-UA',{maximumFractionDigits:1});
const describe=x=>x==null?'—':fmt.format(x);
const region={west:'Захід',east:'Схід'};
async function request(path,token,options={}){
  const r=await fetch('/api/v1'+path,{...options,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(options.headers||{})}});
  if(!r.ok){const e=new Error('HTTP '+r.status);e.status=r.status;throw e;}
  return r;
}
function Icon({kind}){
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
    {kind==='logo'?<path d="M3 19 9 5l4 9 2-4 6 9M6 15l3 2 5-3 4 2"/>:
     kind==='van'?<path d="M2 6h13v11H2zM15 9h4l3 4v4h-7M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>:
     <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>}
  </svg>;
}
function FleetMap({vehicle,track}){
  const el=useRef(), map=useRef(), marker=useRef(), line=useRef(), tiles=useRef();
  const [street,setStreet]=useState(false);
  const lat=vehicle?.latest.lat?.value, lon=vehicle?.latest.lon?.value;
  const gps=vehicle?.status!=='offline' && Number.isFinite(lat) && Number.isFinite(lon);
  useEffect(()=>{
    const m=L.map(el.current,{zoomControl:true,scrollWheelZoom:false}).setView([50.442,30.522],12);
    L.polygon(zone.map(([x,y])=>[y,x]),{color:'#2b6c64',fillColor:'#80a99b',weight:1,dashArray:'5 6',fillOpacity:.2}).addTo(m);
    line.current=L.polyline([],{color:'#28546b',weight:3}).addTo(m);
    map.current=m;
    return ()=>{m.remove();map.current=null;marker.current=null;tiles.current=null;};
  },[]);
  useEffect(()=>{
    const m=map.current;
    if(street && !tiles.current) tiles.current=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(m);
    if(!street && tiles.current){tiles.current.remove();tiles.current=null;}
  },[street]);
  useEffect(()=>{line.current?.setLatLngs(track.map(x=>[x.lat,x.lon]));},[track]);
  useEffect(()=>{
    if(!gps){marker.current?.remove();marker.current=null;return;}
    const draw=()=>{
      if(!map.current)return;
      if(!marker.current)marker.current=L.circleMarker([lat,lon],{radius:9,color:'#fff',weight:3,fillColor:'#143d51',fillOpacity:1}).addTo(map.current);
      else marker.current.setLatLng([lat,lon]);
    };
    const timer=setTimeout(draw,200);
    return ()=>clearTimeout(timer);
  },[lat,lon,gps]);
  return <section className="map-panel" aria-labelledby="map-title"><div className="panel-title"><div><h2 id="map-title">Позиція та геозона</h2><p>{vehicle?.name || 'Оберіть транспорт'}</p></div><button type="button" onClick={()=>setStreet(!street)} aria-pressed={street}>{street?'Схема':'Вулиці OSM'}</button></div>
    <div ref={el} className="map" aria-label="Карта маршруту"></div>
    <div className="map-note">{gps ? <span data-gps={lat.toFixed(5)+','+lon.toFixed(5)}>GPS {lat.toFixed(5)}, {lon.toFixed(5)}</span> : <span>Немає актуальної позиції</span>}<span>{track.length} точок треку</span></div>
  </section>;
}
function FuelChart({points}){
  if(points.length===0)return <div className="chart-empty">Показань за цей період немає.</div>;
  const width=740,height=153;
  const start=points[0].ts, duration=Math.max(1,points.at(-1).ts-start);
  const path=points.map((v,i)=>(i?'L':'M')+(36+(v.ts-start)/duration*(width-52))+','+(116-v.value*.95)).join(' ');
  const time=ts=>new Intl.DateTimeFormat('uk-UA',{hour:'2-digit',minute:'2-digit'}).format(ts);
  return <svg viewBox={'0 0 '+width+' '+height} role="img" aria-label="Графік залишку пального за часом">
    {[0,25,50,75,100].map(v=><g key={v}><text x="4" y={121-v*.95}>{v}</text><line x1="36" x2="724" y1={116-v*.95} y2={116-v*.95}/></g>)}
    <path d={path} fill="none" stroke="#2b6c64" strokeWidth="3" vectorEffect="non-scaling-stroke"/>
    {points.length===1&&<circle cx="36" cy={116-points[0].value*.95} r="4" fill="#2b6c64"/>}
    <text x="36" y="145">{time(start)}</text><text x="687" y="145">{time(points.at(-1).ts)}</text>
  </svg>;
}
function VehicleCard({vehicle:d, selected, onClick}){
  return <li><button className="vehicle" aria-pressed={selected} onClick={onClick}><Icon kind="van"/><span className="vehicle-copy"><strong>{d.name}</strong><span>{d.route} · {region[d.region]}</span><span className={'status '+d.status}><i></i>{statuses[d.status]}</span></span><span className="numbers"><strong>{describe(d.latest.speed?.value)} <small>км/год</small></strong><span>{describe(d.latest.fuel?.value)}% пального</span></span></button></li>;
}
function App(){
  const [session,setSession]=useState(null), [vehicles,setVehicles]=useState([]), [selected,setSelected]=useState('truck-07');
  const [range,setRange]=useState('day'), [filter,setFilter]=useState('all'), [zoneFilter,setZoneFilter]=useState('all');
  const [fuel,setFuel]=useState([]),[track,setTrack]=useState([]),[status,setStatus]=useState('З’єднання…'),[attempts,setAttempts]=useState(0);
  const [failure,setFailure]=useState(''),[historyError,setHistoryError]=useState(''),[updating,setUpdating]=useState(false);
  const [username,setUsername]=useState('dispatch-west'),[password,setPassword]=useState('');
  const [pending,setPending]=useState(false);
  const latest=useRef(new Map());
  const active=vehicles.find(x=>x.id===selected);
  function openSession(value){
    setFailure('');setVehicles([]);setSession(value);setPassword('');
  }
  async function login(e){
    e.preventDefault();setPending(true);setFailure('');
    try{
      const r=await request('/auth/login',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      openSession(await r.json());
    }catch(err){setFailure(err.status===401?'Перевірте ім’я користувача та пароль.':'Сервер недоступний. Спробуйте ще раз.');}
    finally{setPending(false);}
  }
  useEffect(()=>{
    if(!session)return;
    let alive=true;
    async function load(){
      try{
        const data=await(await request('/devices',session.accessToken)).json();if(!alive)return;
        setVehicles(data);setFailure('');
        setSelected(id=>data.some(x=>x.id===id)?id:data[0]?.id);
      }catch(e){if(alive)setFailure(e.status===401?'Сеанс завершився. Увійдіть повторно.':'Не вдалося завантажити транспорт.');}
    }
    const socket=io({auth:{token:session.accessToken}});
    socket.on('connect',()=>{setStatus('Наживо');setAttempts(0);load();});
    socket.on('disconnect',()=>setStatus('З’єднання перервано'));
    socket.on('connect_error',()=>{setStatus('Перепідключення');setAttempts(n=>n+1);});
    socket.on('telemetry:update',d=>{
      const key=d.device+':'+d.metric, current=latest.current.get(key);
      if(!current||d.ts>current.ts)latest.current.set(key,d);
    });
    const timer=setInterval(()=>{
      const batch=latest.current;
      latest.current=new Map();
      if(batch.size)setVehicles(all=>all.map(d=>{
        const readings={...d.latest};
        for(const item of batch.values()) if(item.device===d.id && (!readings[item.metric] || item.ts>readings[item.metric].ts))readings[item.metric]={ts:item.ts,value:item.value};
        return {...d,latest:readings,status:vehicleStatus(readings,d)};
      }));
    },1000);
    const expireTimer=setTimeout(async()=>{
      try {
        const reply=await request('/auth/refresh',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:session.refreshToken})});
        if(alive)setSession(await reply.json());
      } catch {if(alive){setSession(null);setFailure('Сеанс завершився. Увійдіть повторно.');}}
    },Math.max(1000,(session.expiresIn-20)*1000));
    load();
    return()=>{alive=false;clearInterval(timer);clearTimeout(expireTimer);socket.disconnect();latest.current.clear();};
  },[session]);
  useEffect(()=>{
    if(!session||!selected)return;
    const controller=new AbortController();
    const to=Date.now(), from=to-(range==='week'?604800000:86400000);
    setUpdating(true);setHistoryError('');setFuel([]);setTrack([]);
    const query='device='+encodeURIComponent(selected)+'&from='+from+'&to='+to;
    Promise.all([
      request('/telemetry?metric=fuel&'+query,session.accessToken,{signal:controller.signal}).then(r=>r.json()),
      request('/track?'+query,session.accessToken,{signal:controller.signal}).then(r=>r.json()),
    ]).then(([f,t])=>{setFuel(f.points);setTrack(t.points);}).catch(e=>{if(e.name!=='AbortError')setHistoryError('Історію не завантажено. Перемкніть період, щоб повторити.');})
      .finally(()=>{if(!controller.signal.aborted)setUpdating(false);});
    return()=>controller.abort();
  },[selected,range,session]);
  async function download(){
    try{
      const to=Date.now(),from=to-(range==='week'?604800000:86400000);
      const response=await request('/track?device='+encodeURIComponent(selected)+'&format=csv&from='+from+'&to='+to,session.accessToken);
      const url=URL.createObjectURL(await response.blob()), a=document.createElement('a');
      a.href=url;a.download=selected+'-track.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch{setHistoryError('Не вдалося експортувати трек.');}
  }
  const displayed=vehicles.filter(d=>(filter==='all'||d.status===filter)&&(zoneFilter==='all'||zoneFilter===d.region));
  return <><header className="top"><div className="shell top-inner"><a className="brand" href="./"><Icon kind="logo"/> Fleet Watch</a><span>Транспортний парк</span>{session&&<button onClick={()=>{setSession(null);setFailure('');}} type="button">Вийти</button>}</div></header>
  {!session?<main className="shell login"><h1>Вхід до парку</h1><p>Диспетчер бачить парк. Водій бачить призначений автомобіль.</p><form onSubmit={login}><label>Користувач<input value={username} autoComplete="username" onChange={e=>setUsername(e.target.value)} required/></label><label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button className="primary" disabled={pending}>{pending?'Вхід…':'Увійти'}</button>{failure&&<p role="alert" className="error">{failure}</p>}</form></main>:
  <main className="shell"><div className="heading"><div><h1>Моніторинг автопарку</h1><p>Навчальна телеметрія · {session.role==='driver'?'Водій':('Диспетчер · '+region[session.region])}</p></div><div className="connection" role="status"><i className={status==='Наживо'?'live':''}></i>{status}{attempts>0?' · '+attempts:''}</div></div>
  {failure&&<p className="error" role="alert">{failure}</p>}
  <div className="workspace"><section className="fleet" aria-labelledby="fleet-title"><div className="panel-title"><div><h2 id="fleet-title">Транспорт</h2><p>{displayed.length} із {vehicles.length} ТЗ</p></div></div>
    <div className="filters"><label>Регіон<select value={zoneFilter} onChange={e=>setZoneFilter(e.target.value)}><option value="all">Усі</option><option value="west">Захід</option><option value="east">Схід</option></select></label><label>Стан<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Усі</option>{Object.entries(statuses).map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label></div>
    {displayed.length?<ul className="vehicles">{displayed.map(d=><VehicleCard key={d.id} vehicle={d} selected={d.id===selected} onClick={()=>setSelected(d.id)}/>)}</ul>:<p className="empty">Транспорту за цими умовами немає.</p>}
  </section><FleetMap vehicle={active} track={track}/></div>
  <section className="history" aria-labelledby="history-title"><div className="panel-title"><div><h2 id="history-title">Залишок пального</h2><p>{active?.name || 'Обраний автомобіль'} · % бака · двигун {active?.latest.engine?.value===1?'працює':'вимкнений'}</p></div><div className="controls"><div className="range" aria-label="Період"><button aria-pressed={range==='day'} onClick={()=>setRange('day')}>Доба</button><button aria-pressed={range==='week'} onClick={()=>setRange('week')}>Тиждень</button></div><button onClick={download}><Icon kind="download"/> CSV</button></div></div>
  {historyError?<p role="alert" className="error">{historyError}</p>:updating?<p role="status" className="chart-empty">Завантаження історії…</p>:<FuelChart points={fuel}/>}</section></main>}</>;
}
createRoot(document.querySelector('#root')).render(<App/>);
