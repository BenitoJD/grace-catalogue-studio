import { Platform, Share } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

export type ShareOutcome = 'shared' | 'copied' | 'dismissed' | 'unavailable';

function isDismissal(error: unknown): boolean {
  const name = error && typeof error === 'object' ? (error as { name?: string }).name : undefined;
  return name === 'AbortError' || name === 'NotAllowedError';
}

/**
 * Shares a link. Native uses the system share sheet. Web uses the Web Share
 * API when the browser has it, otherwise copies the link to the clipboard.
 */
export async function shareLink({
  title,
  message,
  url,
}: {
  title: string;
  message?: string;
  url: string;
}): Promise<ShareOutcome> {
  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined') {
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ title, text: message, url });
          return 'shared';
        } catch (shareError) {
          if (isDismissal(shareError)) {
            return 'dismissed';
          }
        }
      }
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(url);
          return 'copied';
        } catch {
          return 'unavailable';
        }
      }
    }
    return 'unavailable';
  }

  try {
    await Share.share({ title, message: message ? `${message}\n${url}` : url, url });
    return 'shared';
  } catch (shareError) {
    return isDismissal(shareError) ? 'dismissed' : 'unavailable';
  }
}

/** Opens a PDF or any other web document, in a browser sheet on native. */
export async function openUrl(url: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    return;
  }
  await WebBrowser.openBrowserAsync(url);
}
