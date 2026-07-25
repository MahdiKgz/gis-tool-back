export const ringPathKey = (
  featureIndex: number,
  geometryCollectionPath: number[],
  coordinatePath: number[],
): string =>
  `${featureIndex}|${geometryCollectionPath.join(".")}|${coordinatePath.join(
    ".",
  )}`;
