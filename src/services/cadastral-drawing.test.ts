import assert from "node:assert/strict";
import test from "node:test";
import { parseDrawing } from "./cadastral-drawing.service";

const line = { id: "line-1", kind: "line", vertices: [[51, 35], [52, 35]] };
const parcel = { id: "parcel-1", kind: "parcel", vertices: [[51, 35], [52, 35], [52, 36], [51, 36]] };

test("validates cadastral drawing revisions and normalizes the persisted payload", () => {
  assert.deepEqual(parseDrawing({ revision: 0, features: [{ ...line, ignored: "value" }, parcel] }), {
    revision: 0, features: [line, parcel],
  });
  assert.deepEqual(parseDrawing({ revision: 3, features: [] }), { revision: 3, features: [] });
  assert.throws(() => parseDrawing({ revision: -1, features: [] }), { code: "INVALID_DRAWING" });
  assert.throws(() => parseDrawing({ revision: 0, features: [line, line] }), { code: "INVALID_DRAWING" });
});

test("rejects out-of-range coordinates, repeated vertices, collinear rings and crossed parcels", () => {
  for (const vertices of [
    [[181, 35], [52, 35], [52, 36]],
    [[51, 35], [52, 35], [52, 36], [51, 35]],
    [[51, 35], [52, 35], [53, 35]],
    [[51, 35], [52, 36], [51, 36], [53, 35]],
  ]) {
    assert.throws(() => parseDrawing({ revision: 1, features: [{ ...parcel, vertices }] }), { code: "INVALID_DRAWING" });
  }
});
