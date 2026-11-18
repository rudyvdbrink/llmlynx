// Exact replacements in source text, for edit_files: the rules of edit_file's
// text edits (tools/files/src/edit.py). Each edit's text must occur exactly
// once, unless the edit says `all`; edits are made in order, and one that does
// not fit fails the whole call, before anything is written. Line ends in the
// file may be "\r\n" where the model wrote "\n".

import { excerpt, occurrences } from "./source";

export type TextEdit = { find: string; replace: string; all: boolean };

// How many places of a text that occurs more than once an error names
const MAX_PLACES = 3;

/** Where `find` occurs in `text`: the first few lines, numbered, so that the model can tell them apart. */
function linePlaces(text: string, places: number[]): string[] {
  return places.slice(0, MAX_PLACES).map((at) => {
    const start = text.lastIndexOf("\n", at - 1) + 1;
    const end = text.indexOf("\n", at);
    const line = text.slice(start, end >= 0 ? end : text.length).replace(/\r$/, "");
    const number = text.slice(0, at).split("\n").length;
    return `line ${number}: ${excerpt(line, at - start, 120)}`;
  });
}

const quoted = (text: string) => JSON.stringify(text.length > 120 ? `${text.slice(0, 120)}…` : text);

/** The edits made on `text`, or the error of the first that does not fit (`number` from 1). */
export function applyTextEdits(text: string, edits: TextEdit[]): { text: string } | { error: string } {
  for (const [i, edit] of edits.entries()) {
    const number = i + 1;
    let find = edit.find;
    let places = occurrences(text, find);
    if (!places.length && text.includes("\r\n")) {
      const crlf = find.replace(/\r?\n/g, "\r\n");
      const crlfPlaces = occurrences(text, crlf);
      if (crlfPlaces.length) [find, places] = [crlf, crlfPlaces];
    }
    if (!places.length) {
      return { error: `Edit ${number}: this text was not found: ${quoted(edit.find)}. Copy the text exactly as the file has it.` };
    }
    if (places.length > 1 && !edit.all) {
      const found = linePlaces(text, places);
      const label = places.length <= found.length ? "Where" : `The first ${found.length}`;
      return {
        error:
          `Edit ${number}: this text occurs ${places.length} times: ${quoted(edit.find)}. ${label}:\n` +
          found.map((place) => `- ${place}`).join("\n") +
          "\nGive more of the text around the one to change, or set all to true to replace every occurrence.",
      };
    }
    const replace = find !== edit.find ? edit.replace.replace(/\r?\n/g, "\r\n") : edit.replace;
    const used = edit.all ? places : places.slice(0, 1);
    let out = "";
    let from = 0;
    for (const at of used) {
      out += text.slice(from, at) + replace;
      from = at + find.length;
    }
    text = out + text.slice(from);
  }
  return { text };
}
