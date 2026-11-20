import aedes from 'aedes';
import {createServer} from 'node:net';
import {once} from 'node:events';
import mqtt from 'mqtt';
import {createFleet} from './server.js';
import {startGeofence} from './geofence.js';

const broker=aedes();
const net=createServer(broker.handle);
net.listen(0,'127.0.0.1');await once(net,'listening');
const mqttUrl='mqtt://127.0.0.1:'+net.address().port;
const password=process.env.FLEET_PASSWORD || 'Fleet-local-demo-19';
const fleet=createFleet({mqttUrl,secret:'demo-local-key-'+crypto.randomUUID(),password,origin:'http://localhost:5173'});
const geo=startGeofence(mqttUrl);
const publisher=mqtt.connect(mqttUrl);
await once(publisher,'connect');
fleet.http.listen(Number(process.env.PORT||3080),'127.0.0.1');
await once(fleet.http,'listening');
async function ready(){
  for(let i=0;i<50;i++){
    const response=await fetch('http://127.0.0.1:'+fleet.http.address().port+'/api/v1/health');
    if(response.ok)return;
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  throw new Error('broker did not become ready');
}
await ready();
const devices=[
  ['truck-07',50.449,30.514,54,63,0],
  ['truck-12',50.416,30.494,72,16,0],
  ['van-03',50.472,30.550,41,8,0],
  ['van-08',50.428,30.539,0,38,225000]
];
const now=Date.now();
async function update(row,ts,i){
  const [id,lat,lon,speed,fuel,delay]=row;
  const sample={lat:lat+Math.sin(i/8)*.010,lon:lon+Math.cos(i/7)*.013,
    speed:Math.max(0,speed+Math.round(Math.cos(i/4)*4)),fuel:Math.min(100,fuel+Math.max(0,20-i)*.18),engine:Number(speed>0)};
  for(const [metric,value] of Object.entries(sample)){
    await publisher.publishAsync('fleet/'+id+'/telemetry',JSON.stringify({ts:ts-delay,metric,value}),{qos:1});
  }
}
for(let i=0;i<20;i++)for(const row of devices)await update(row,now-(19-i)*270000,i);
let step=20, active=false;
const timer=setInterval(async()=>{
  if(active)return;active=true;
  try{for(const row of devices.filter(x=>x[5]===0))await update(row,Date.now(),step);step++;}
  catch(error){console.error(error.message);}
  finally{active=false;}
},1200);
console.log(JSON.stringify({event:'demo_ready',url:'http://127.0.0.1:'+fleet.http.address().port,users:['dispatch-west','dispatch-east','driver']}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{
  clearInterval(timer);
  await publisher.endAsync(true);await geo.endAsync(true);await fleet.close();
  await new Promise(resolve=>broker.close(resolve));net.close();
});
