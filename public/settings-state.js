// Submit only deliberate edits: an unchanged checkbox must not undo discovery
// or overwrite a setting another viewer changed since this form was opened.
export function accountSelectionChanges(saved = {}, selections = {}) {
  return Object.fromEntries(Object.entries(selections)
    .filter(([id, checked]) => typeof checked === 'boolean' && checked !== Boolean(saved[id])));
}

export function mergeAccountSelections(saved, selections, incoming) {
  return { ...incoming, ...accountSelectionChanges(saved, selections) };
}
