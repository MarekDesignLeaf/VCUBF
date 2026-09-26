"""Canonical Alfonzo realtime entrypoint.

The old module name `emma_realtime` is kept only for already installed runtime
compatibility. New code should execute this module.
"""

import runpy


if __name__ == "__main__":
    runpy.run_module("emma_realtime", run_name="__main__")
