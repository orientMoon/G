import { Syringe } from 'mana-syringe';
import type { DisplayObject } from '../display-objects';
import type { IElement } from '../dom';
import type { StyleValueRegistry } from './interfaces';

export const CSSPropertySyntaxFactory = Syringe.defineToken('');
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type CSSPropertySyntaxFactory = <P, U>(syntax: string) => CSSProperty<P, U>;

export type Interpolatable = number | boolean | number[] | boolean[];
type CSSPropertyMixer<Parsed = any, T extends Interpolatable = any> = (
  left: Parsed,
  right: Parsed,
  displayObject: IElement | null,
) => [T, T, (i: T) => string | any] | undefined;

type CSSPropertyParser<Parsed> = (value: string | any, object: DisplayObject) => Parsed;

type CSSPropertyCalculator<Parsed, Used> = (
  name: string,
  oldParsed: Parsed,
  parsed: Parsed,
  object: IElement,
  registry: StyleValueRegistry,
) => Used;

export const CSSProperty = Syringe.defineToken('');
/**
 * 1. parser: raw CSS string -> Computed Value
 * 2. calculator: Computed Value -> Used Value
 * 3. mixer(in animation system): Used Value -> new Used Value
 * 4. post processor
 */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export interface CSSProperty<Parsed, Used> {
  /**
   * parse CSS string to CSSStyleValue
   *
   * @example
   * '10' -> CSS.number(10)
   * '10px' -> CSS.px(10)
   * '180deg' -> CSS.deg(180)
   */
  parser: CSSPropertyParser<Parsed>;

  /**
   * convert parsed value to used value.
   * eg. in `lineWidth`, convert [CSSUnitValue] to [CSSUnitValue, CSSUnitValue]
   *
   * in Blink, it convert a CSSValue to an appropriate platform value
   */
  calculator: CSSPropertyCalculator<Parsed, Used>;

  /**
   * used with interpolation in animation system
   */
  mixer: CSSPropertyMixer<Used>;

  preProcessor: (object: IElement) => void;

  /**
   * eg. update local position after x/y/z caculated
   */
  postProcessor: (object: IElement) => void;
}
