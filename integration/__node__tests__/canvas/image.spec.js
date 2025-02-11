const { createCanvas, Image: CanvasImage } = require('canvas');
const fs = require('fs');
const { Image, Canvas } = require('@antv/g');
const { Renderer } = require('@antv/g-canvas');
const { sleep, diff } = require('../../util');

// create a node-canvas
const nodeCanvas = createCanvas(200, 200);

// create a renderer, unregister plugin relative to DOM
const renderer = new Renderer();
const domInteractionPlugin = renderer.getPlugin('dom-interaction');
renderer.unregisterPlugin(domInteractionPlugin);

const SIZE = 200;
const canvas = new Canvas({
  width: SIZE,
  height: SIZE,
  canvas: nodeCanvas, // use node-canvas
  renderer,
  createImage: () => {
    const image = new CanvasImage();
    return image;
  },
});

const RESULT_IMAGE = '/image.png';
const BASELINE_IMAGE_DIR = '/snapshots';

describe('Render <Image> with g-canvas', () => {
  afterEach(() => {
    canvas.removeChildren();
    fs.rmSync(__dirname + RESULT_IMAGE);
  });

  afterAll(() => {
    canvas.destroy();
  });

  it('should render image on server-side correctly.', async () => {
    await canvas.ready;
    const image = new Image({
      style: {
        width: 100,
        height: 100,
        src: 'https://gw.alipayobjects.com/mdn/rms_6ae20b/afts/img/A*N4ZMS7gHsUIAAAAAAAAAAABkARQnAQ',
      },
    });
    canvas.appendChild(image);

    await sleep(300);

    await new Promise((resolve) => {
      const out = fs.createWriteStream(__dirname + RESULT_IMAGE);
      const stream = nodeCanvas.createPNGStream();
      stream.pipe(out);
      out.on('finish', () => {
        resolve(undefined);
      });
    });

    expect(diff(__dirname + RESULT_IMAGE, __dirname + BASELINE_IMAGE_DIR + RESULT_IMAGE)).toBe(0);
  });
});
