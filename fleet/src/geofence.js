import mqtt from 'mqtt';
import {point,isOutsideGeofence,zone} from './domain.js';

export function startGeofence(url){
  const client=mqtt.connect(url,{reconnectPeriod:500});
  const gps=new Map();
  client.on('error',()=>{});
  client.on('connect',()=>client.subscribe('fleet/+/telemetry',{qos:1}));
  client.on('message',(topic,buffer)=>{
    const match=/^fleet\/([a-z0-9-]+)\/telemetry$/.exec(topic);
    if(!match || buffer.length>2048)return;
    let data;try{data=point(JSON.parse(buffer));}catch{return;}
    if(!data || !['lat','lon'].includes(data.metric))return;
    const key=match[1]+':'+data.ts;
    const pair=gps.get(key)||{};
    pair[data.metric]=data.value;
    if(pair.lat!==undefined && pair.lon!==undefined){
      gps.delete(key);
      client.publish('fleet/'+match[1]+'/geofence',JSON.stringify({ts:data.ts,outside:isOutsideGeofence([pair.lon,pair.lat],zone)}),{qos:1});
    }else{
      gps.set(key,pair);
      if(gps.size>512)gps.delete(gps.keys().next().value);
    }
  });
  return client;
}
if(process.argv[1] && import.meta.url===new URL('file:'+process.argv[1].replaceAll('\\','/')).href) startGeofence(process.env.MQTT_URL||'mqtt://127.0.0.1:1883');
