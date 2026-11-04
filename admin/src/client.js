import { createClient } from '@shared/api.js';

export const api = createClient('driver-go-admin');

export async function openBlob(path, filename) {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  if (filename) {
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    link.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
