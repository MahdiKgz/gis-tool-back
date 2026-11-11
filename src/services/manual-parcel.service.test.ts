import assert from "node:assert/strict";
import test from "node:test";
import { validateParcelGeometry } from "./manual-parcel.service";

const shell = [
  [0, 0, 5],
  [4, 0, 6],
  [4, 4, 7],
  [0, 4, 8],
  [0, 0, 5],
];
const hole = [
  [1, 1, 3],
  [1, 2, 3],
  [2, 2, 3],
  [2, 1, 3],
  [1, 1, 3],
];

test("manual parcel validation preserves holes, separate polygon parts and additional ordinates", () => {
  const geometry = {
    type: "MultiPolygon",
    coordinates: [[shell, hole], [shell.map(([x, y, z]) => [x! + 8, y, z])]],
  };
  assert.deepEqual(validateParcelGeometry(geometry, "MultiPolygon"), geometry);
});

test("manual parcel validation rejects open, crossed and collapsed rings, and holes outside the shell", () => {
  const invalidRings = [
    [shell.slice(0, -1)],
    [
      [
        [0, 0],
        [4, 4],
        [4, 0],
        [0, 4],
        [0, 0],
      ],
    ],
    [
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [0, 0],
      ],
    ],
    [shell, hole.map(([x, y, z]) => [x! + 8, y, z])],
    [
      [
        [181, 0],
        [182, 0],
        [182, 1],
        [181, 0],
      ],
    ],
  ];
  for (const coordinates of invalidRings) {
    assert.throws(() => validateParcelGeometry({ type: "Polygon", coordinates }, "Polygon"), {
      code: "INVALID_PARCEL_GEOMETRY",
    });
  }
  assert.throws(() => validateParcelGeometry({ type: "Point", coordinates: [0, 0] }, "Polygon"), {
    code: "INVALID_PARCEL_GEOMETRY",
  });
});
