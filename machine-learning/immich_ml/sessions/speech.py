from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from immich_ml.schemas import ModelInput, SessionNode, Shape
from immich_ml.sessions.ort import GraphSpec


class SpeechSession:
    shapes = (Shape(batch=1),)
    batches = (1,)
    normalizes_input = False

    def __init__(self, model_path: Path, threads: int = 2) -> None:
        spec = GraphSpec(model_path, {}, [], ["CPUExecutionProvider"], [], threads)
        self._session = spec.session(model_path)

    def for_shape(self, shape: Shape) -> "SpeechSession":
        if shape != self.shapes[0]:
            raise ValueError("Speech recognition processes one audio window at a time")
        return self

    def warm(self) -> None:
        pass

    def get_inputs(self) -> Sequence[SessionNode]:
        inputs: Sequence[SessionNode] = self._session.get_inputs()
        return inputs

    def get_outputs(self) -> Sequence[SessionNode]:
        outputs: Sequence[SessionNode] = self._session.get_outputs()
        return outputs

    def get_metadata(self) -> dict[str, str]:
        metadata: dict[str, str] = self._session.get_modelmeta().custom_metadata_map
        return metadata

    def run(
        self, output_names: list[str] | None, input_feed: ModelInput, run_options: Any = None
    ) -> list[NDArray[np.float32]]:
        output: list[NDArray[np.float32]] = self._session.run(output_names, input_feed, run_options)
        return output
