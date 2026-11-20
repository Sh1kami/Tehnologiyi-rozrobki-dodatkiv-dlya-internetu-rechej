import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isOverspeed,isOutsideGeofence,vehicleStatus,point,validSettings,averageBuckets,simplifyTrack,zone} from '../src/domain.js';

for (const [speed,limit,tolerance,expected] of [[58,60,0,false],[60,60,0,false],[61,60,0,true],[63,60,3,false],[64,60,3,true]]) {
  test('overspeed '+[speed,limit,tolerance].join('/'),()=>assert.equal(isOverspeed(speed,limit,tolerance),expected));
}
for(const args of [[-1,60],[NaN,60],[50,0],[50,60,-1]])test('invalid speed '+args,()=>assert.throws(()=>isOverspeed(...args),RangeError));
for(const [name,position,out] of [['inside',[30.50,50.43],false],['outside',[30.66,50.42],true],['edge',[30.47,50.42],false],['vertex',zone[0],false]]) {
  test('geofence '+name,()=>assert.equal(isOutsideGeofence(position,zone),out));
}
test('geofence rejects invalid input',()=>assert.throws(()=>isOutsideGeofence([NaN,0],zone)));
test('GPS rejects latitude and longitude beyond bounds',()=>{
  assert.equal(point({ts:1,metric:'lat',value:91}),null);
  assert.equal(point({ts:1,metric:'lon',value:-181}),null);
});
test('invalid telemetry fields, bounds and engine readings',()=>{
  for(const item of [null,{ts:-1,metric:'lat',value:0},{ts:1,metric:'unknown',value:1},{ts:1,metric:'engine',value:.5},{ts:1,metric:'fuel',value:110}]) assert.equal(point(item),null);
  assert.deepEqual(point({ts:1,metric:'fuel',value:10}),{ts:1,metric:'fuel',value:10});
});
test('status boundaries for stale GPS, fuel, zone and speed',()=>{
  const preferences={fuelMinPercent:10,speedLimit:60};
  const latest={lat:{ts:1000,value:50.44},lon:{ts:1000,value:30.51},fuel:{value:40},speed:{value:60}};
  assert.equal(vehicleStatus({},preferences,1000),'offline');
  assert.equal(vehicleStatus(latest,preferences,181001),'offline');
  assert.equal(vehicleStatus(latest,preferences,181000),'normal');
  assert.equal(vehicleStatus({...latest,fuel:{value:9}},preferences,1000),'critical');
  assert.equal(vehicleStatus({...latest,fuel:{value:20}},preferences,1000),'warning');
  assert.equal(vehicleStatus({...latest,speed:{value:61}},preferences,1000),'speed');
  assert.equal(vehicleStatus({...latest,lon:{ts:1000,value:30.70}},preferences,1000),'outside');
});
test('settings validation and bucket averages',()=>{
  assert.equal(Boolean(validSettings(null)),false);
  assert.equal(validSettings({speedLimit:62,fuelMinPercent:10}),false);
  assert.equal(validSettings({speedLimit:60,fuelMinPercent:10}),true);
  assert.deepEqual(averageBuckets([{ts:0,value:20},{ts:1,value:40},{ts:900000,value:60}]),[{ts:0,value:30,count:2},{ts:900000,value:60,count:1}]);
});
test('RDP preserves endpoints and order, <= 500 points',()=>{
  const input=Array.from({length:750},(_,i)=>({ts:i,lat:50.43+Math.sin(i*2)*.001,lon:30.45+i*.0001}));
  const result=simplifyTrack(input);
  assert.ok(result.length<=500);
  assert.equal(result[0],input[0]);assert.equal(result.at(-1),input.at(-1));
  assert.ok(result.every((x,i)=>!i||x.ts>result[i-1].ts));
  assert.equal(simplifyTrack(input.slice(0,10)).length,10);
});
