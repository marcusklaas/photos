/** Settings come from localStorage, so they can be anything. Run: node scripts/test-encode.mjs */
import {
  ENCODE_DEFAULTS,
  ENCODE_BOUNDS,
  coerceEncodeSettings,
  isDefaultEncodeSettings,
} from '../src/encode-settings.ts';

let ok = true;
const eq = (label, a, b) => {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  if (!pass) {
    ok = false;
    console.log(`FAIL ${label}\n  got  ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`);
  } else console.log(`ok   ${label}`);
};

const D = ENCODE_DEFAULTS;

// --- nothing stored at all
eq('null is the defaults', coerceEncodeSettings(null), D);
eq('undefined is the defaults', coerceEncodeSettings(undefined), D);
eq('empty object is the defaults', coerceEncodeSettings({}), D);

// --- a value that is not an object cannot take a field with it
eq('a string is the defaults', coerceEncodeSettings('68'), D);
eq('an array is the defaults', coerceEncodeSettings([68, 5]), D);

// --- ordinary settings survive intact
const custom = { quality: 80, speed: 8, enableSharpYUV: false };
eq('valid settings pass through', coerceEncodeSettings(custom), custom);

// --- the form hands back strings; they are numbers by the time we store them
eq('numeric strings are parsed', coerceEncodeSettings({ quality: '72', speed: '4' }), {
  ...D,
  quality: 72,
  speed: 4,
});

// --- out of range clamps to the bound rather than falling back
eq('quality clamps high', coerceEncodeSettings({ quality: 500 }).quality, ENCODE_BOUNDS.quality.max);
eq('quality clamps low', coerceEncodeSettings({ quality: -5 }).quality, ENCODE_BOUNDS.quality.min);
eq('speed clamps high', coerceEncodeSettings({ speed: 99 }).speed, ENCODE_BOUNDS.speed.max);
eq('speed clamps low', coerceEncodeSettings({ speed: -1 }).speed, ENCODE_BOUNDS.speed.min);

// --- the encoder wants integers
eq('fractions round', coerceEncodeSettings({ quality: 67.6 }).quality, 68);

// --- junk in one field must not cost you the other two
eq('one bad field falls back alone', coerceEncodeSettings({ quality: 'abc', speed: 3 }), {
  ...D,
  speed: 3,
});
eq('an emptied input falls back', coerceEncodeSettings({ quality: '' }).quality, D.quality);
eq('NaN falls back', coerceEncodeSettings({ speed: NaN }).speed, D.speed);
eq('null field falls back', coerceEncodeSettings({ quality: null }).quality, D.quality);

// --- the checkbox is a boolean or it is nothing
eq('non-boolean sharpYUV falls back', coerceEncodeSettings({ enableSharpYUV: 'yes' }).enableSharpYUV, D.enableSharpYUV);
eq('false is kept, not treated as missing', coerceEncodeSettings({ enableSharpYUV: false }).enableSharpYUV, false);

// --- unknown keys are dropped, so nothing extra reaches the encoder
eq('unknown keys are dropped', Object.keys(coerceEncodeSettings({ lossless: true })).sort(), Object.keys(D).sort());

// --- the pill in the settings panel
eq('defaults read as default', isDefaultEncodeSettings(D), true);
eq('a changed field reads as custom', isDefaultEncodeSettings({ ...D, quality: D.quality + 1 }), false);
eq('a changed checkbox reads as custom', isDefaultEncodeSettings({ ...D, enableSharpYUV: !D.enableSharpYUV }), false);

// --- the defaults themselves have to be inside the bounds they advertise
eq('default quality is in bounds',
  D.quality >= ENCODE_BOUNDS.quality.min && D.quality <= ENCODE_BOUNDS.quality.max, true);
eq('default speed is in bounds',
  D.speed >= ENCODE_BOUNDS.speed.min && D.speed <= ENCODE_BOUNDS.speed.max, true);
eq('defaults survive a round trip', coerceEncodeSettings(JSON.parse(JSON.stringify(D))), D);

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
