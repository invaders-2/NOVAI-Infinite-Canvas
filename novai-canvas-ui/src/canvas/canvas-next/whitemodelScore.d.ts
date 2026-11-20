export function sobel(lum: Float32Array, w: number, h: number): Float32Array;
export function dilateMax(map: Float32Array, w: number, h: number, r?: number): Float32Array;
export function maskedStructureScore(lumA: Float32Array, lumB: Float32Array, w: number, h: number): { score: number; keptRatio: number };
