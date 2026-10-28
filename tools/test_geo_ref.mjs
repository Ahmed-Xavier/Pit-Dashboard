#!/usr/bin/env node
import { GeoReference, EARTH_RADIUS_M } from '../src/geo/geoRef.js';

const datum = { lat: 50.3568, lon: 18.4027 };
const geo = new GeoReference({ datum, mapYawOffsetDeg: 90 });
const points = [[0, 0], [1, 1], [-1200, 450], [3500, -2700], [25_000, 12_000]];
let maxRoundTripErrorM = 0;
for (const [x, y] of points) {
  const ll = geo.toLatLon(x, y);
  const back = geo.fromLatLon(ll.lat, ll.lon);
  maxRoundTripErrorM = Math.max(maxRoundTripErrorM, Math.hypot(back.x - x, back.y - y));
}
const rotated = new GeoReference({ datum, mapYawOffsetDeg: 31 });
const rotatedRoundTrip = rotated.fromLatLon(...Object.values(rotated.toLatLon(123, -456)));
const phi0 = datum.lat * Math.PI / 180;
const angular = 100 / EARTH_RADIUS_M;
const destinationLat = Math.asin(Math.sin(phi0) * Math.cos(angular));
const destinationLon = datum.lon * Math.PI / 180 + Math.atan2(Math.sin(Math.PI / 2) * Math.sin(angular) * Math.cos(phi0), Math.cos(angular) - Math.sin(phi0) * Math.sin(destinationLat));
const knownEast = geo.fromLatLon(destinationLat * 180 / Math.PI, destinationLon * 180 / Math.PI);
const northLat = Math.asin(Math.sin(phi0) * Math.cos(angular) + Math.cos(phi0) * Math.sin(angular));
const knownNorth = geo.fromLatLon(northLat * 180 / Math.PI, datum.lon);
const result = { roundTripSamples: points.length, maxRoundTripErrorM, rotatedRoundTrip: { x: rotatedRoundTrip.x, y: rotatedRoundTrip.y }, mapYawOffsetDeg: 90, known100mEast: knownEast, known100mNorth: knownNorth };
console.log(JSON.stringify(result, null, 2));
if (maxRoundTripErrorM > 0.01 || Math.abs(rotatedRoundTrip.x - 123) > 0.01 || Math.abs(rotatedRoundTrip.y + 456) > 0.01 || Math.abs(knownEast.x) > 0.01 || Math.abs(knownEast.y + 100) > 0.01 || Math.abs(knownNorth.x - 100) > 0.01 || Math.abs(knownNorth.y) > 0.01) process.exitCode = 1;
