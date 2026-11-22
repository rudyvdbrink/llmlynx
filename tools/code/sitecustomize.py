"""Puts the chat's installed packages on sys.path in a run of code (see src/jail.py).

Python imports this module at every start, from the image's site-packages. A
run sees the chat's packages at /opt/packages/python. They go on sys.path here
rather than through PYTHONPATH, so that code which sets PYTHONPATH itself, such
as PYTHONPATH=src, still finds them. They come before the libraries the image
has built in, so that an installed version is the one imported. Where that
folder does not exist, such as in the server, this does nothing.
"""

import os
import site
import sys

PACKAGES = "/opt/packages/python"


def _add_packages():
    if PACKAGES in sys.path or not os.path.isdir(PACKAGES):
        return
    built_in = set(site.getsitepackages())
    at = next((i for i, path in enumerate(sys.path) if path in built_in), len(sys.path))
    sys.path.insert(at, PACKAGES)


_add_packages()
