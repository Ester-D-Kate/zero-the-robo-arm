export async function createCameraFixture(page) {
  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 800;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#253c36";
      ctx.fillRect(0, 0, 600, 800);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    }),
    "base64",
  );
  let released = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      let timer;
      return new Response(
        new ReadableStream({
          start(controller) {
            const frame = () => {
              controller.enqueue(
                new TextEncoder().encode(
                  "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                    jpeg.length +
                    "\r\n\r\n",
                ),
              );
              controller.enqueue(jpeg);
              controller.enqueue(new TextEncoder().encode("\r\n"));
            };
            frame();
            timer = setInterval(frame, 100);
          },
          cancel() {
            clearInterval(timer);
            released = true;
          },
        }),
        {
          headers: {
            "Content-Type": "multipart/x-mixed-replace;boundary=frame",
            "Cache-Control": "no-store",
          },
        },
      );
    },
  });
  return { server, released: () => released };
}
