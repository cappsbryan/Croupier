import { groupmeAccessToken } from "./secrets";

export async function uploadImage(
  stream: ReadableStream,
  mimeType: string
): Promise<string> {
  const uploadResponse = await fetch("https://image.groupme.com/pictures", {
    body: stream as any, // this any shouldn't be necessary soonish
    duplex: "half",
    method: "post",
    headers: {
      "X-Access-Token": await groupmeAccessToken(),
      "Content-Type": mimeType,
    },
  });
  const uploadResponseBody = (await uploadResponse.json()) as {
    payload: { url: string | undefined } | undefined;
  };
  const imageUrl = uploadResponseBody?.payload?.url;
  if (!imageUrl) {
    console.warn("upload response:", uploadResponseBody);
    console.warn("upload response headers:");
    uploadResponse.headers.forEach((value, key) => {
      console.warn(`${key}: ${value}`);
    });
    throw new Error("Failed to upload image to GroupMe image service");
  }
  return imageUrl;
}
