import type {
  BaseStyleProps,
  DisplayObject,
  ParsedBaseStyleProps,
  PickingResult,
  RenderingPlugin,
  RenderingService,
  Shape,
  IDocument,
} from '@antv/g-lite';
import { RenderingContext } from '@antv/g-lite';
import {
  CanvasConfig,
  findClosestClipPathTarget,
  inject,
  OffscreenCanvasCreator,
  Point,
  RenderingPluginContribution,
  singleton,
  Syringe,
} from '@antv/g-lite';
import type { PathGenerator } from '@antv/g-plugin-canvas-path-generator';
import { PathGeneratorFactory } from '@antv/g-plugin-canvas-path-generator';
import { mat4, vec3 } from 'gl-matrix';

export const PointInPathPickerFactory = Syringe.defineToken('');
export type PointInPathPicker<T extends BaseStyleProps> = (
  displayObject: DisplayObject<T>,
  point: Point,
  isPointInPath?: (displayObject: DisplayObject<T>, point: Point) => boolean,
) => boolean;

const tmpVec3a = vec3.create();
const tmpVec3b = vec3.create();
const tmpVec3c = vec3.create();
const tmpMat4 = mat4.create();

/**
 * pick shape(s) with Mouse/Touch event
 *
 * 1. find AABB with r-tree
 * 2. do math calculation with geometry in an accurate way
 */
@singleton({ contrib: RenderingPluginContribution })
export class CanvasPickerPlugin implements RenderingPlugin {
  static tag = 'CanvasPicker';

  private pathGeneratorFactoryCache: Record<Shape | string, PathGenerator<any>> = {};

  constructor(
    @inject(RenderingContext)
    private renderingContext: RenderingContext,

    @inject(CanvasConfig)
    private canvasConfig: CanvasConfig,

    @inject(OffscreenCanvasCreator)
    private offscreenCanvas: OffscreenCanvasCreator,

    @inject(PathGeneratorFactory)
    private pathGeneratorFactory: (tagName: Shape | string) => PathGenerator<any>,

    @inject(PointInPathPickerFactory)
    private pointInPathPickerFactory: (tagName: Shape | string) => PointInPathPicker<any>,
  ) {}

  apply(renderingService: RenderingService) {
    const document = this.renderingContext.root?.ownerDocument;

    renderingService.hooks.pick.tapPromise(
      CanvasPickerPlugin.tag,
      async (result: PickingResult) => {
        return this.pick(document, result);
      },
    );

    renderingService.hooks.pickSync.tap(CanvasPickerPlugin.tag, (result: PickingResult) => {
      return this.pick(document, result);
    });
  }

  private pick(document: IDocument, result: PickingResult) {
    const {
      topmost,
      position: { x, y },
    } = result;

    // position in world space
    const position = vec3.set(tmpVec3a, x, y, 0);

    // query by AABB first with spatial index(r-tree)
    const hitTestList = document.elementsFromBBox(
      position[0],
      position[1],
      position[0],
      position[1],
    );

    // const rBushNodes = this.rBush.search({
    //   minX: position[0],
    //   minY: position[1],
    //   maxX: position[0],
    //   maxY: position[1],
    // });

    // const queriedIds = rBushNodes.map((node) => node.id);
    // const hitTestList: DisplayObject[] = [];
    // rBushNodes.forEach(({ id }) => {
    //   const displayObject = this.displayObjectPool.getByEntity(id);
    //   const { pointerEvents } = displayObject.parsedStyle as ParsedBaseStyleProps;

    //   // account for `visibility`
    //   // @see https://developer.mozilla.org/en-US/docs/Web/CSS/pointer-events
    //   const isVisibilityAffected = [
    //     'auto',
    //     'visiblepainted',
    //     'visiblefill',
    //     'visiblestroke',
    //     'visible',
    //   ].includes(pointerEvents);

    //   if (
    //     (!isVisibilityAffected || (isVisibilityAffected && displayObject.isVisible())) &&
    //     !displayObject.isCulled() &&
    //     displayObject.isInteractive()
    //   ) {
    //     // parent is not included, eg. parent is clipped
    //     if (
    //       displayObject.parentNode &&
    //       queriedIds.indexOf((displayObject.parentNode as Element).entity) === -1
    //     ) {
    //       return;
    //     }

    //     hitTestList.push(displayObject);
    //   }
    // });
    // // find group with max z-index
    // hitTestList.sort((a, b) => b.sortable.renderOrder - a.sortable.renderOrder);

    // test with clip path & origin shape
    // @see https://github.com/antvis/g/issues/1064
    const pickedDisplayObjects: DisplayObject[] = [];
    for (const displayObject of hitTestList) {
      let worldTransform = displayObject.getWorldTransform();
      const isHitOriginShape = this.isHit(displayObject, position, worldTransform);
      if (isHitOriginShape) {
        // should look up in the ancestor node
        const clipped = findClosestClipPathTarget(displayObject);
        if (clipped) {
          const clipPath = clipped.style.clipPath;
          worldTransform = mat4.multiply(
            tmpMat4,
            clipped === displayObject ? worldTransform : clipped.getWorldTransform(),
            clipPath.getLocalTransform(),
          );

          const isHitClipPath = this.isHit(clipPath, position, worldTransform);
          if (isHitClipPath) {
            if (topmost) {
              result.picked = [displayObject];
              return result;
            } else {
              pickedDisplayObjects.push(displayObject);
            }
          }
        } else {
          if (topmost) {
            result.picked = [displayObject];
            return result;
          } else {
            pickedDisplayObjects.push(displayObject);
          }
        }
      }
    }

    result.picked = pickedDisplayObjects;
    return result;
  }

  private isHit = (displayObject: DisplayObject, position: vec3, worldTransform: mat4) => {
    // use picker for current shape's type
    const pick = this.pointInPathPickerFactory(displayObject.nodeName);
    if (pick) {
      // invert with world matrix
      const invertWorldMat = mat4.invert(tmpMat4, worldTransform);

      // transform client position to local space, do picking in local space
      const localPosition = vec3.transformMat4(
        tmpVec3b,
        vec3.set(tmpVec3c, position[0], position[1], 0),
        invertWorldMat,
      );

      // account for anchor
      const { halfExtents } = displayObject.getGeometryBounds();
      const { anchor } = displayObject.parsedStyle as ParsedBaseStyleProps;
      localPosition[0] += ((anchor && anchor[0]) || 0) * halfExtents[0] * 2;
      localPosition[1] += ((anchor && anchor[1]) || 0) * halfExtents[1] * 2;
      if (pick(displayObject, new Point(localPosition[0], localPosition[1]), this.isPointInPath)) {
        return true;
      }
    }

    return false;
  };

  /**
   * use native picking method
   * @see https://developer.mozilla.org/zh-CN/docs/Web/API/CanvasRenderingContext2D/isPointInPath
   */
  private isPointInPath = (displayObject: DisplayObject, position: Point) => {
    const context = this.offscreenCanvas.getOrCreateContext(
      this.canvasConfig.offscreenCanvas,
    ) as CanvasRenderingContext2D;

    if (this.pathGeneratorFactoryCache[displayObject.nodeName] === undefined) {
      this.pathGeneratorFactoryCache[displayObject.nodeName] = this.pathGeneratorFactory(
        displayObject.nodeName,
      );
    }
    const generatePath = this.pathGeneratorFactoryCache[displayObject.nodeName];
    if (generatePath) {
      context.beginPath();
      generatePath(context, displayObject.parsedStyle);
      context.closePath();
    }

    return context.isPointInPath(position.x, position.y);
  };
}
