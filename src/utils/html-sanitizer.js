import createDOMPurify from 'dompurify';

let purifier;
let purifierWindow;

const getPurifier = () => {
  if (typeof createDOMPurify?.sanitize === 'function') {
    return createDOMPurify;
  }

  const currentWindow = globalThis.window;
  if (!currentWindow?.document || typeof createDOMPurify !== 'function') {
    return null;
  }

  if (!purifier || purifierWindow !== currentWindow) {
    purifier = createDOMPurify(currentWindow);
    purifierWindow = currentWindow;
  }

  return purifier;
};

export const sanitizeHtml = (html, options = {}) => {
  const activePurifier = getPurifier();
  if (!activePurifier) return '';

  return activePurifier.sanitize(String(html || ''), options);
};
