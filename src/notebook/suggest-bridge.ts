type SuggestApi = {
  move: (dir: 1 | -1) => boolean;
  accept: () => boolean;
  cancel: () => boolean;
};

let api: SuggestApi | null = null;

export function bindSuggest(next: SuggestApi | null) {
  api = next;
}

export function suggestMove(dir: 1 | -1) {
  return api?.move(dir) ?? false;
}

export function suggestAccept() {
  return api?.accept() ?? false;
}

export function suggestCancel() {
  return api?.cancel() ?? false;
}
