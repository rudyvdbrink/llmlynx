"""The classifier: Llama Prompt Guard 2 as an ONNX model, run on the CPU with onnxruntime.

The model directory is made when the image is built (see build/prepare_model.py)
and holds model.onnx, tokenizer.json, config.json and guard.json. Nothing is
fetched at runtime.
"""

import json
import re
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR = Path(__file__).resolve().parent.parent / "model"


def malicious_index(id2label: dict) -> int:
    """Which output of the model is the malicious label, from the labels in its config.

    The label with a name such as MALICIOUS is taken. A config that only
    numbers its two labels (LABEL_0, LABEL_1) follows the usual order, with the
    positive class last. The build checks the outcome on a known injection, so
    a wrong reading cannot go unnoticed (see build/prepare_model.py).
    """
    labels = {int(index): str(name) for index, name in id2label.items()}
    named = [index for index, name in labels.items() if re.search("malicious|injection|jailbreak", name, re.I)]
    if len(named) == 1:
        return named[0]
    if not named and sorted(labels) == [0, 1] and all(re.fullmatch(r"LABEL_\d", name) for name in labels.values()):
        return 1
    raise ValueError(f"Cannot tell which label is the malicious one: {labels}")


class Model:
    """Turns text into token ids and scores chunks of them. Loaded once, when the server starts."""

    def __init__(self, directory: Path = MODEL_DIR):
        config = json.loads((directory / "config.json").read_text())
        about = json.loads((directory / "guard.json").read_text())
        self.name: str = about["model"]
        self.malicious = malicious_index(config["id2label"])

        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        # The chunks are cut here (see scan.py): the tokenizer must not cut or pad by itself
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()
        self.cls, self.sep, self.pad = (self._special(token) for token in ("[CLS]", "[SEP]", "[PAD]"))

        self.session = ort.InferenceSession(str(directory / "model.onnx"), providers=["CPUExecutionProvider"])
        self.inputs = {entry.name for entry in self.session.get_inputs()}

    def _special(self, token: str) -> int:
        index = self.tokenizer.token_to_id(token)
        if index is None:
            raise ValueError(f"The tokenizer has no {token} token.")
        return index

    def encode(self, text: str) -> list[int]:
        """The token ids of the text, without special tokens."""
        return self.tokenizer.encode(text, add_special_tokens=False).ids

    def offsets(self, text: str) -> list[tuple[int, int]]:
        """Where each token of the text is in it, as (start, end); the same tokens as `encode`."""
        return self.tokenizer.encode(text, add_special_tokens=False).offsets

    def score(self, chunks: list[list[int]]) -> list[float]:
        """The probability of the malicious label for each chunk, in one run of the model."""
        rows = [[self.cls, *chunk, self.sep] for chunk in chunks]
        width = max(len(row) for row in rows)
        ids = np.full((len(rows), width), self.pad, dtype=np.int64)
        mask = np.zeros((len(rows), width), dtype=np.int64)
        for i, row in enumerate(rows):
            ids[i, : len(row)] = row
            mask[i, : len(row)] = 1
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        logits = self.session.run(None, feed)[0]
        # Softmax over the labels
        exp = np.exp(logits - logits.max(axis=1, keepdims=True))
        return (exp[:, self.malicious] / exp.sum(axis=1)).tolist()
