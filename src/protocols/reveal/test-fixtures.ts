/** Synthetic examples of fields consumed by the official web app, not account captures. */
import type { RevealPhoto } from "./client";
export const credentials = { email: "owner@example.com", password: "test-password-not-real" };
export const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
export const samplePhoto: RevealPhoto = {
  photoId: "photo-1", cameraId: "camera-1",
  photoUrl: "https://reveal-example.s3.us-east-1.amazonaws.com/photo-1.jpg?X-Amz-Signature=private-example",
  photoTimestamp: "09/11/2026 08:15", createdTimestamp: 1789139700000,
};
export function authResponse(token = "test-access", refresh = "test-refresh", expiresIn = 3600): Response {
  return Response.json({ AuthenticationResult: { AccessToken: token, RefreshToken: refresh, ExpiresIn: expiresIn } });
}
export function photoResponse(photos: readonly RevealPhoto[] = [samplePhoto], nextToken?: string): Response {
  return Response.json({ success: true, response: { photos, ...(nextToken ? { nextToken } : {}) } });
}
export function imageResponse(): Response { return new Response(jpeg, { headers: { "content-type": "image/jpeg" } }); }
