import exifr from 'exifr';

export type Exif = {
  /**
   * Local wall-clock time at capture, "YYYY-MM-DDTHH:mm:ss", no timezone.
   * EXIF records no offset, so converting to UTC would invent information and
   * can shift the displayed day near midnight. Keep it floating.
   */
  t?: string;
  g?: [number, number];
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Format a Date as floating local time, matching how EXIF recorded it. */
function floating(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Pulls capture time and GPS out of a file. Runs BEFORE any pixel work, because
 * re-encoding destroys EXIF entirely — anything we don't read here is gone.
 */
export async function readExif(file: File): Promise<Exif> {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = (await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
    })) as Record<string, unknown> | undefined;
  } catch {
    return {};
  }
  if (!parsed) return {};

  const out: Exif = {};

  const when = parsed['DateTimeOriginal'] ?? parsed['CreateDate'] ?? parsed['ModifyDate'];
  if (when instanceof Date && !Number.isNaN(when.valueOf())) out.t = floating(when);

  const lat = parsed['latitude'];
  const lon = parsed['longitude'];
  if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) {
    out.g = [lat, lon];
  }
  return out;
}
