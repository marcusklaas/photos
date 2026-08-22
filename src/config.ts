import { WIDTHS, SHARD_SIZE, ENCODE } from './encode-settings.js';

export { WIDTHS, SHARD_SIZE, ENCODE };

declare const __MEDIA_BASE_URL__: string;
declare const __DEV__: boolean;

/** Origin (or relative path) the media repo is served from. Set at build time. */
export const MEDIA_BASE_URL: string = __MEDIA_BASE_URL__.replace(/\/$/, '');

export const DEV: boolean = __DEV__;

export const mediaUrl = (path: string): string => `${MEDIA_BASE_URL}/${path}`;
export const variantUrl = (id: string, width: number): string => mediaUrl(`p/${id}-${width}.avif`);
