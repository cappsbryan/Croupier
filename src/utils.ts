export function chunked<T>(arr: T[]): T[][] {
  const chunkSize = 25; // max number of request items in a BatchWriteItem

  let chunks: T[][] = [];
  for (let i = 0; i * chunkSize < arr.length; i += 1) {
    const chunk: T[] = [];
    for (let j = 0; j < 25 && i * chunkSize + j < arr.length; j += 1) {
      chunk.push(arr[i * chunkSize + j] as T); // safe to assume because of the condition on the loop
    }
    chunks.push(chunk);
  }
  return chunks;
}
