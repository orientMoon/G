import type {
  ICamera,
  CSSGradientValue,
  DataURLOptions,
  DataURLType,
  DisplayObject,
  LinearGradient,
  ParsedBaseStyleProps,
  Pattern,
  RadialGradient,
  RenderingPlugin,
  RenderingService,
} from '@antv/g-lite';
import { UnitType } from '@antv/g-lite';
import {
  CanvasConfig,
  computeLinearGradient,
  computeRadialGradient,
  ContextService,
  CSSRGB,
  DefaultCamera,
  getEuler,
  GradientType,
  inject,
  isPattern,
  parseColor,
  rad2deg,
  RenderingContext,
  RenderingPluginContribution,
  Shape,
  singleton,
} from '@antv/g-lite';
import { ImagePool } from '@antv/g-plugin-image-loader';
import { isNil, isString } from '@antv/util';
import type {
  Canvas,
  EmbindEnumEntity,
  EncodedImageFormat,
  InputRect,
  ManagedSkottieAnimation,
  Paint,
  Particles,
  TextureSource,
} from 'canvaskit-wasm';
import { mat4, quat, vec3 } from 'gl-matrix';
import { FontLoader } from './FontLoader';
import type { CanvasKitContext, RendererContribution } from './interfaces';
import { CanvaskitRendererPluginOptions, RendererContributionFactory } from './interfaces';

/**
 * @see https://skia.org/docs/user/modules/quickstart/
 */
@singleton({ contrib: RenderingPluginContribution })
export class CanvaskitRendererPlugin implements RenderingPlugin {
  static tag = 'CanvaskitRenderer';

  constructor(
    @inject(CanvasConfig)
    private canvasConfig: CanvasConfig,

    @inject(ContextService)
    private contextService: ContextService<CanvasKitContext>,

    @inject(RenderingContext)
    private renderingContext: RenderingContext,

    @inject(DefaultCamera)
    private camera: ICamera,

    @inject(RendererContributionFactory)
    private rendererContributionFactory: (tagName: Shape | string) => RendererContribution,

    @inject(FontLoader)
    private fontLoader: FontLoader,

    @inject(ImagePool)
    private imagePool: ImagePool,

    @inject(CanvaskitRendererPluginOptions)
    private canvaskitRendererPluginOptions: CanvaskitRendererPluginOptions,
  ) {}

  private renderingService: RenderingService;

  private destroyed = false;

  private animations: {
    name: string;
    jsonStr: string;
    bounds: InputRect;
    assets?: any;
    duration: number;
    size: Float32Array;
    animation: ManagedSkottieAnimation;
  }[] = [];

  private particlesList: {
    particles: Particles;
    onFrame: (canvas: Canvas) => void;
  }[] = [];

  private enableCapture: boolean;
  private captureOptions: Partial<DataURLOptions>;
  private capturePromise: Promise<any> | undefined;
  private resolveCapturePromise: (dataURL: string) => void;

  playAnimation(name: string, jsonStr: string, bounds?: InputRect, assets?: any) {
    const canvasKitContext = this.contextService.getContext();
    const { CanvasKit } = canvasKitContext;
    const animation = CanvasKit.MakeManagedAnimation(jsonStr, assets);
    const duration = animation.duration() * 1000;
    const size = animation.size();
    this.animations.push({
      name,
      jsonStr,
      bounds: bounds || CanvasKit.LTRBRect(0, 0, size[0], size[1]),
      assets,
      duration,
      size,
      animation,
    });
    return animation;
  }

  createParticles(jsonStr: string, onFrame?: (canvas: Canvas) => void, assets?: any) {
    const canvasKitContext = this.contextService.getContext();
    const { CanvasKit } = canvasKitContext;
    const particles = CanvasKit.MakeParticles(jsonStr, assets);
    this.particlesList.push({ particles, onFrame });
    return particles;
  }

  apply(renderingService: RenderingService) {
    this.renderingService = renderingService;
    renderingService.hooks.init.tapPromise(CanvaskitRendererPlugin.tag, async () => {
      const canvasKitContext = this.contextService.getContext();
      const { surface, CanvasKit } = canvasKitContext;
      const { fonts } = this.canvaskitRendererPluginOptions;

      // load default fonts 'sans-serif', 'NotoSansCJK-Regular.ttf'
      await Promise.all(
        fonts.map(({ name, url }) => this.fontLoader.loadFont(CanvasKit, name, url)),
      );

      const { background } = this.canvasConfig;
      const clearColor = parseColor(background) as CSSRGB;

      // scale all drawing operations by the dpr
      // @see https://www.html5rocks.com/en/tutorials/canvas/hidpi/
      const dpr = this.contextService.getDPR();
      surface.getCanvas().scale(dpr, dpr);

      const firstFrame = Date.now();
      const tmpVec3 = vec3.create();
      const tmpQuat = quat.create();

      const drawFrame = (canvas: Canvas) => {
        if (this.destroyed || surface.isDeleted()) {
          return;
        }

        canvas.save();

        this.applyCamera(canvas, tmpVec3, tmpQuat);

        canvas.clear(
          CanvasKit.Color4f(
            Number(clearColor.r) / 255,
            Number(clearColor.g) / 255,
            Number(clearColor.b) / 255,
            Number(clearColor.alpha),
          ),
        );

        this.drawAnimations(canvas, firstFrame);
        this.drawParticles(canvas);
        this.drawWithSurface(canvas, this.renderingContext.root);

        canvas.restore();

        // capture here since we don't preserve drawing buffer
        if (this.enableCapture && this.resolveCapturePromise) {
          const { type = 'image/png', encoderOptions = 1 } = this.captureOptions;

          const typeMap: Record<DataURLType, EncodedImageFormat> = {
            'image/png': CanvasKit.ImageFormat.PNG,
            'image/jpeg': CanvasKit.ImageFormat.JPEG,
            'image/webp': CanvasKit.ImageFormat.WEBP,
            'image/bmp': undefined,
          };

          // TODO: transparent image
          const snapshot = surface.makeImageSnapshot();
          const bytes = snapshot.encodeToBytes(typeMap[type], encoderOptions);
          const blobObj = new Blob([bytes], { type });
          this.resolveCapturePromise(window.URL.createObjectURL(blobObj));
          this.enableCapture = false;
          this.captureOptions = undefined;
          this.resolveCapturePromise = undefined;
        }

        surface.requestAnimationFrame(drawFrame);
      };
      surface.requestAnimationFrame(drawFrame);
    });

    renderingService.hooks.destroy.tap(CanvaskitRendererPlugin.tag, () => {
      this.destroyed = true;
      this.animations.forEach(({ animation }) => {
        animation.delete();
      });
      this.animations = [];
      this.particlesList.forEach(({ particles }) => {
        particles.delete();
      });
      this.particlesList = [];
      this.fontLoader.destroy();
    });
  }

  private applyCamera(canvas: Canvas, tmpVec3: vec3, tmpQuat: quat) {
    const transform = this.camera.getOrthoMatrix();
    const [tx, ty] = mat4.getTranslation(tmpVec3, transform);
    const [sx, sy] = mat4.getScaling(tmpVec3, transform);
    const rotation = mat4.getRotation(tmpQuat, transform);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [eux, euy, euz] = getEuler(tmpVec3, rotation);
    const rot = rad2deg(euz);

    canvas.translate(tx, ty);
    canvas.rotate(rot, 0, 0);
    canvas.scale(sx, sy);
  }

  private drawAnimations(canvas: Canvas, firstFrame: number) {
    const rectLeft = 0;
    const rectTop = 1;
    const rectRight = 2;
    const rectBottom = 3;
    this.animations.forEach(({ duration, animation, bounds }, i) => {
      if (animation.isDeleted()) {
        this.animations.splice(i, 1);
      }

      const seek = ((Date.now() - firstFrame) / duration) % 1.0;
      const damage = animation.seek(seek);

      if (damage[rectRight] > damage[rectLeft] && damage[rectBottom] > damage[rectTop]) {
        animation.render(canvas, bounds);
      }
    });
  }

  private drawParticles(canvas: Canvas) {
    this.particlesList.forEach(({ particles, onFrame }, i) => {
      if (particles.isDeleted()) {
        this.particlesList.splice(i, 1);
      }

      canvas.save();
      if (onFrame) {
        onFrame(canvas);
      }
      particles.update(Date.now() / 1000.0);
      particles.draw(canvas);
      canvas.restore();
    });
  }

  private drawWithSurface(canvas: Canvas, object: DisplayObject) {
    this.renderDisplayObject(object, canvas);
    const sorted = object.sortable.sorted || object.childNodes;

    // should account for z-index
    sorted.forEach((child: DisplayObject) => {
      this.drawWithSurface(canvas, child);
    });
  }

  private generatePattern(object: DisplayObject, pattern: Pattern) {
    const { surface, CanvasKit } = this.contextService.getContext();
    const { image, repetition } = pattern;

    let src: TextureSource;
    if (isString(image)) {
      src = this.imagePool.getImageSync(image, () => {
        // set dirty rectangle flag
        object.renderable.dirty = true;
        this.renderingService.dirtify();
      });
    } else {
      // @ts-ignore
      src = image;
    }

    if (src) {
      // TODO: check image.complete
      // WebGL: INVALID_VALUE: texImage2D: invalid image
      const decoded = surface.makeImageFromTextureSource(src);
      if (decoded) {
        let tx: EmbindEnumEntity;
        let ty: EmbindEnumEntity;
        if (repetition === 'repeat') {
          tx = CanvasKit.TileMode.Repeat;
          ty = CanvasKit.TileMode.Repeat;
        } else if (repetition === 'repeat-x') {
          tx = CanvasKit.TileMode.Repeat;
          ty = CanvasKit.TileMode.Decal;
        } else if (repetition === 'repeat-y') {
          tx = CanvasKit.TileMode.Decal;
          ty = CanvasKit.TileMode.Repeat;
        } else if (repetition === 'no-repeat') {
          tx = CanvasKit.TileMode.Decal;
          ty = CanvasKit.TileMode.Decal;
        }
        const pattern = decoded.makeShaderCubic(tx, ty, 1 / 3, 1 / 3);
        return pattern;
      }
    }
  }

  private generateGradient(object: DisplayObject, stroke: CSSGradientValue) {
    const { CanvasKit } = this.contextService.getContext();
    const bounds = object.getGeometryBounds();
    const width = (bounds && bounds.halfExtents[0] * 2) || 0;
    const height = (bounds && bounds.halfExtents[1] * 2) || 0;

    if (stroke.type === GradientType.LinearGradient) {
      // @see https://fiddle.skia.org/c/@GradientShader_MakeLinear
      const { angle, steps } = stroke.value as LinearGradient;
      const pos: number[] = [];
      const colors: number[] = [];
      steps.forEach(({ offset, color }) => {
        if (offset.unit === UnitType.kPercentage) {
          pos.push(offset.value / 100);
        }
        const c = parseColor(color) as CSSRGB;
        colors.push(
          Number(c.alpha) === 0 ? 1 : Number(c.r) / 255,
          Number(c.alpha) === 0 ? 1 : Number(c.g) / 255,
          Number(c.alpha) === 0 ? 1 : Number(c.b) / 255,
          Number(c.alpha),
        );
      });
      const { x1, y1, x2, y2 } = computeLinearGradient(width, height, angle);
      const gradient = CanvasKit.Shader.MakeLinearGradient(
        [x1, y1],
        [x2, y2],
        new Float32Array(colors),
        pos,
        CanvasKit.TileMode.Mirror,
      );
      return gradient;
    } else if (stroke.type === GradientType.RadialGradient) {
      const { cx, cy, steps, size } = stroke.value as RadialGradient;
      const { x, y, r } = computeRadialGradient(width, height, cx, cy, size);
      const pos: number[] = [];
      const colors: Float32Array[] = [];
      steps.forEach(({ offset, color }) => {
        if (offset.unit === UnitType.kPercentage) {
          pos.push(offset.value / 100);
        }
        const c = parseColor(color) as CSSRGB;
        colors.push(
          new Float32Array([
            Number(c.alpha) === 0 ? 1 : Number(c.r) / 255,
            Number(c.alpha) === 0 ? 1 : Number(c.g) / 255,
            Number(c.alpha) === 0 ? 1 : Number(c.b) / 255,
            Number(c.alpha),
          ]),
        );
      });
      // @see https://fiddle.skia.org/c/@radial_gradient_test
      const gradient = CanvasKit.Shader.MakeRadialGradient(
        [x, y],
        r,
        colors,
        pos,
        CanvasKit.TileMode.Clamp, // mirror for repetition
      );
      return gradient;
    }
  }

  private generateGradientsShader(object: DisplayObject, fill: CSSGradientValue[]) {
    const { CanvasKit } = this.contextService.getContext();
    const gradientShaders = fill.map((gradient) => this.generateGradient(object, gradient));
    let previousShader = gradientShaders[0];
    for (let i = 1; i < gradientShaders.length; i++) {
      previousShader = CanvasKit.Shader.MakeBlend(
        // @see https://developer.mozilla.org/zh-CN/docs/Web/API/CanvasRenderingContext2D/globalCompositeOperation
        CanvasKit.BlendMode.SrcOver,
        previousShader,
        gradientShaders[i],
      );
    }
    return previousShader;
  }

  private renderDisplayObject(object: DisplayObject, canvas: Canvas) {
    const { CanvasKit } = this.contextService.getContext();

    if (
      !object.isVisible() ||
      object.isCulled() ||
      object.nodeName == Shape.GROUP ||
      object.nodeName == Shape.HTML ||
      object.nodeName == Shape.MESH
    ) {
      return;
    }

    canvas.save();

    const {
      fill,
      stroke,
      lineWidth,
      lineCap,
      lineJoin,
      lineDash,
      lineDashOffset,
      miterLimit,
      opacity,
      fillOpacity,
      strokeOpacity,
      shadowBlur,
      shadowColor,
    } = object.parsedStyle as ParsedBaseStyleProps;

    const hasFill = !isNil(fill) && !(fill as CSSRGB).isNone;
    const hasStroke = !isNil(stroke) && !(stroke as CSSRGB).isNone;
    const hasShadow = !isNil(shadowColor) && shadowBlur > 0;

    let fillPaint: Paint = null;
    let strokePaint: Paint = null;
    let shadowFillPaint: Paint = null;
    let shadowStrokePaint: Paint = null;

    if (hasFill) {
      fillPaint = new CanvasKit.Paint();
      fillPaint.setAntiAlias(true);
      fillPaint.setStyle(CanvasKit.PaintStyle.Fill);
      // should not affect transparent
      if (fill instanceof CSSRGB && !fill.isNone) {
        fillPaint.setColorComponents(
          Number(fill.r) / 255,
          Number(fill.g) / 255,
          Number(fill.b) / 255,
          Number(fill.alpha) * fillOpacity * opacity,
        );
      } else if (Array.isArray(fill)) {
        fillPaint.setAlphaf(fillOpacity * opacity);
        const shader = this.generateGradientsShader(object, fill);
        fillPaint.setShader(shader);
        shader.delete();
      } else if (isPattern(fill)) {
        fillPaint.setAlphaf(fillOpacity * opacity);
        const shader = this.generatePattern(object, fill);
        if (shader) {
          fillPaint.setShader(shader);
          shader.delete();
        }
      }
    }

    if (hasStroke) {
      strokePaint = new CanvasKit.Paint();
      /**
       * stroke
       */
      if (lineWidth > 0) {
        strokePaint.setAntiAlias(true);
        strokePaint.setStyle(CanvasKit.PaintStyle.Stroke);
        if (stroke instanceof CSSRGB && !stroke.isNone) {
          strokePaint.setColor(
            CanvasKit.Color4f(
              Number(stroke.r) / 255,
              Number(stroke.g) / 255,
              Number(stroke.b) / 255,
              Number(stroke.alpha) * strokeOpacity * opacity,
            ),
          );
        } else if (Array.isArray(stroke)) {
          strokePaint.setAlphaf(strokeOpacity * opacity);
          const shader = this.generateGradientsShader(object, stroke);
          strokePaint.setShader(shader);
          shader.delete();
        } else if (isPattern(stroke)) {
          strokePaint.setAlphaf(strokeOpacity * opacity);
          const shader = this.generatePattern(object, stroke);
          if (shader) {
            strokePaint.setShader(shader);
            shader.delete();
          }
        }

        strokePaint.setStrokeWidth(lineWidth);
        const STROKE_CAP_MAP = {
          butt: CanvasKit.StrokeCap.Butt,
          round: CanvasKit.StrokeCap.Round,
          square: CanvasKit.StrokeCap.Square,
        };
        strokePaint.setStrokeCap(STROKE_CAP_MAP[lineCap]);
        const STROKE_JOIN_MAP = {
          bevel: CanvasKit.StrokeJoin.Bevel,
          round: CanvasKit.StrokeJoin.Round,
          miter: CanvasKit.StrokeJoin.Miter,
        };
        strokePaint.setStrokeJoin(STROKE_JOIN_MAP[lineJoin]);
        if (!isNil(miterLimit)) {
          strokePaint.setStrokeMiter(miterLimit);
        }

        if (lineDash) {
          strokePaint.setPathEffect(CanvasKit.PathEffect.MakeDash(lineDash, lineDashOffset || 0));
        }
      }
    }

    if (hasFill && hasShadow) {
      shadowFillPaint = fillPaint.copy();
      shadowFillPaint.setAntiAlias(true);
      shadowFillPaint.setColor(
        CanvasKit.Color4f(
          Number(shadowColor.r) / 255,
          Number(shadowColor.g) / 255,
          Number(shadowColor.b) / 255,
          Number(shadowColor.alpha),
        ),
      );
      const blurSigma = ((shadowBlur && shadowBlur) || 0) / 2;
      shadowFillPaint.setMaskFilter(
        CanvasKit.MaskFilter.MakeBlur(CanvasKit.BlurStyle.Normal, blurSigma, false),
      );
    }
    if (hasStroke && hasShadow) {
      shadowStrokePaint = strokePaint.copy();
      shadowStrokePaint.setAntiAlias(true);
      shadowStrokePaint.setColor(
        CanvasKit.Color4f(
          Number(shadowColor.r) / 255,
          Number(shadowColor.g) / 255,
          Number(shadowColor.b) / 255,
          Number(shadowColor.alpha),
        ),
      );
      const blurSigma = ((shadowBlur && shadowBlur) || 0) / 2;
      shadowStrokePaint.setMaskFilter(
        CanvasKit.MaskFilter.MakeBlur(CanvasKit.BlurStyle.Normal, blurSigma, false),
      );
    }

    /**
     * world transform
     */
    const [tx, ty] = object.getPosition();
    const [sx, sy] = object.getScale();
    const rot = object.getEulerAngles();
    const [ax, ay] = object.getLocalSkew();

    // @see https://fiddle.skia.org/c/68b54cb7d3435f46e532e6d565a59c49
    canvas.translate(tx, ty);
    // FIXME
    canvas.skew(ax, ay);
    canvas.rotate(rot, 0, 0);
    canvas.scale(sx, sy);

    const bounds = object.getGeometryBounds();
    const width = (bounds && bounds.halfExtents[0] * 2) || 0;
    const height = (bounds && bounds.halfExtents[1] * 2) || 0;
    const { anchor } = (object.parsedStyle || {}) as ParsedBaseStyleProps;

    const translateX = -(((anchor && anchor[0]) || 0) * width);
    const translateY = -(((anchor && anchor[1]) || 0) * height);
    if (translateX !== 0 || translateY !== 0) {
      // apply anchor, use true size, not include stroke,
      // eg. bounds = true size + half lineWidth
      canvas.translate(translateX, translateY);
    }

    const renderer = this.rendererContributionFactory(object.nodeName);
    if (renderer) {
      renderer.render(object, {
        fillPaint,
        strokePaint,
        shadowFillPaint,
        shadowStrokePaint,
        canvas,
      });
    }

    fillPaint?.delete();
    strokePaint?.delete();
    shadowFillPaint?.delete();
    shadowStrokePaint?.delete();

    canvas.restore();
  }

  async toDataURL(options: Partial<DataURLOptions>) {
    // trigger re-render
    this.enableCapture = true;
    this.captureOptions = options;
    this.capturePromise = new Promise((resolve) => {
      this.resolveCapturePromise = (dataURL: string) => {
        resolve(dataURL);
      };
    });
    return this.capturePromise;
  }
}
