import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';

/**
 * Copy text from the app. Electron and browsers occasionally refuse the async
 * clipboard API outside a direct gesture, so fall back to the older selection
 * based copy rather than leaving the person with a dead button.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    if (Platform.OS !== 'web') return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const element = document.createElement('textarea');
        element.value = text;
        element.setAttribute('readonly', '');
        element.style.position = 'fixed';
        element.style.opacity = '0';
        document.body.appendChild(element);
        element.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(element);
        return ok;
      } catch {
        return false;
      }
    }
  }
}
