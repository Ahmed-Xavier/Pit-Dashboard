const EARTH_RADIUS_M = 6_378_137;
const radians = (degrees) => degrees * Math.PI / 180;
const degrees = (radiansValue) => radiansValue * 180 / Math.PI;

/** Local tangent-plane map frame tied to a geodetic datum. */
export class GeoReference {
  constructor({ datum, mapYawOffsetDeg = 0 }) {
    if (!Number.isFinite(datum?.lat) || !Number.isFinite(datum?.lon)) throw new TypeError('geo datum needs finite lat and lon');
    this.lat0 = radians(datum.lat);
    this.lon0 = radians(datum.lon);
    this.yaw = radians(mapYawOffsetDeg);
    this.cosYaw = Math.cos(this.yaw);
    this.sinYaw = Math.sin(this.yaw);
  }

  /** Convert geographic coordinates to the dashboard ROS map frame (meters). */
  fromLatLon(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new TypeError('latitude and longitude must be finite');
    const phi = radians(lat);
    const lam = radians(lon);
    const dLam = lam - this.lon0;
    const cosC = Math.max(-1, Math.min(1, Math.sin(this.lat0) * Math.sin(phi) + Math.cos(this.lat0) * Math.cos(phi) * Math.cos(dLam)));
    const central = Math.acos(cosC);
    if (central < 1e-15) return { x: 0, y: 0 };
    const bearing = Math.atan2(Math.sin(dLam) * Math.cos(phi), Math.cos(this.lat0) * Math.sin(phi) - Math.sin(this.lat0) * Math.cos(phi) * Math.cos(dLam));
    const east = EARTH_RADIUS_M * central * Math.sin(bearing);
    const north = EARTH_RADIUS_M * central * Math.cos(bearing);
    return { x: this.cosYaw * east + this.sinYaw * north, y: -this.sinYaw * east + this.cosYaw * north };
  }

  /** Convert ROS map-frame meters to latitude/longitude. */
  toLatLon(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('map x and y must be finite');
    const east = this.cosYaw * x - this.sinYaw * y;
    const north = this.sinYaw * x + this.cosYaw * y;
    const distance = Math.hypot(east, north);
    if (distance < 1e-12) return { lat: degrees(this.lat0), lon: degrees(this.lon0) };
    const angular = distance / EARTH_RADIUS_M;
    const bearing = Math.atan2(east, north);
    const lat = Math.asin(Math.sin(this.lat0) * Math.cos(angular) + Math.cos(this.lat0) * Math.sin(angular) * Math.cos(bearing));
    const lon = this.lon0 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(this.lat0), Math.cos(angular) - Math.sin(this.lat0) * Math.sin(lat));
    return { lat: degrees(lat), lon: degrees(lon) };
  }
}

export { EARTH_RADIUS_M };
