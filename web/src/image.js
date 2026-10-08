// Preparing a picture for the room. Everything here happens in the browser: the
// file is shrunk, re-encoded and handed to the chat socket as a data URI, so the
// original never leaves the device and nothing is stored anywhere.
//
// Re-encoding through a canvas also drops EXIF, which is the point as much as the
// size is — a phone photo carries GPS coordinates, and "look what I saw" should
// not quietly share where you were standing.

export const MAX_CHARS = 820000; // mirror of IMAGE_MAX_CHARS in RoomDO.js
const MAX_EDGE = 1280;           // longest side after shrinking
const QUALITIES = [0.82, 0.72, 0.62, 0.5]; // tried in order until it fits

export const isImage = (file) => !!file && /^image\/(jpeg|png|webp|gif)$/.test(file.type);

// Roughly how many bytes a data URI of this length carries, for the size label.
export const bytesOf = (dataUrl) => Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);

const readAsDataURL = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = () => reject(new Error('read failed'));
  fr.readAsDataURL(file);
});

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('decode failed'));
  img.src = src;
});

// A canvas only ever yields one frame, so a re-encoded GIF stops moving. GIFs go
// through whole or not at all, which means the cap is the cap.
async function prepareGif(file) {
  const data = await readAsDataURL(file);
  if (data.length > MAX_CHARS) {
    throw new Error('That GIF is too big to share. Under about 600 KB works.');
  }
  return { data, mime: 'image/gif' };
}

export async function prepareImage(file) {
  if (!isImage(file)) throw new Error('That file is not a picture.');
  if (file.type === 'image/gif') return prepareGif(file);

  const img = await loadImage(await readAsDataURL(file));
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // WebP where it exists (much smaller at the same quality), JPEG otherwise.
  const mime = canvas.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
  for (const q of QUALITIES) {
    const data = canvas.toDataURL(mime, q);
    if (data.length <= MAX_CHARS) return { data, mime };
  }
  throw new Error('That picture is too big to share, even shrunk down.');
}
