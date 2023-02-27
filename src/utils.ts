export function chunked<T>(arr: T[]): T[][] {
  const chunkSize = 25; // max number of request items in a BatchWriteItem

  let chunks: T[][] = [];
  for (let i = 0; i * chunkSize < arr.length; i += 1) {
    chunks.push([]);
    for (let j = 0; j < 25 && i * chunkSize + j < arr.length; j += 1) {
      chunks[i].push(arr[i * chunkSize + j]);
    }
  }
  return chunks;
}
