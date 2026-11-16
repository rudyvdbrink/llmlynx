"""Tests of how the malicious label is read from the model's config (src/model.py)."""

import pytest

from model import malicious_index


def test_the_label_named_malicious_is_taken_wherever_it_is():
    assert malicious_index({"0": "BENIGN", "1": "MALICIOUS"}) == 1
    assert malicious_index({"0": "MALICIOUS", "1": "BENIGN"}) == 0
    assert malicious_index({0: "benign", 1: "malicious"}) == 1


def test_other_names_for_the_malicious_label():
    assert malicious_index({"0": "SAFE", "1": "INJECTION"}) == 1
    assert malicious_index({"0": "JAILBREAK", "1": "BENIGN"}) == 0


def test_numbered_labels_follow_the_usual_order():
    assert malicious_index({"0": "LABEL_0", "1": "LABEL_1"}) == 1


@pytest.mark.parametrize(
    "labels",
    [
        {"0": "BENIGN", "1": "INJECTION", "2": "JAILBREAK"},  # two that could be it
        {"0": "A", "1": "B"},  # no name to go by
        {"0": "LABEL_0", "1": "LABEL_1", "2": "LABEL_2"},
    ],
)
def test_labels_that_cannot_be_read_are_an_error(labels):
    with pytest.raises(ValueError):
        malicious_index(labels)
