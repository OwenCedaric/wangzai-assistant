import { smartReplyVariables } from '../constants/smartReplyTemplateCatalog.js';

export function createSmartReplySampleValues() {
  return Object.fromEntries(smartReplyVariables.map((variable) => [variable.code, variable.sample]));
}

export function renderSmartReplyTemplate(template, values = {}) {
  return smartReplyVariables.reduce(
    (message, variable) => {
      const value = String(values[variable.code] ?? '').trim();
      return message.replaceAll(variable.placeholder, value || variable.placeholder);
    },
    String(template || '')
  );
}

export function findMissingSmartReplyVariables(template, values = {}) {
  return smartReplyVariables.filter(
    (variable) => String(template || '').includes(variable.placeholder) && !String(values[variable.code] ?? '').trim()
  );
}
