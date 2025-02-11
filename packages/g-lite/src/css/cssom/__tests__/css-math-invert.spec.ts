import { expect } from 'chai';
import { CSS } from '../../';

describe('CSSMathInvert', () => {
  it('should invert numeric correctly.', () => {
    const number = CSS.number(2);
    const invert = number.invert();

    expect(invert.toString()).to.eqls('0.5');
    expect(invert.clone().toString()).to.eqls('0.5');
    expect(invert.equals(invert.clone())).to.be.true;
    expect(invert.equals(CSS.number(0.5))).to.be.true;
    expect(invert.equals(CSS.number(1))).to.be.false;
    expect(invert.equals(CSS.px(1))).to.be.false;
    expect(invert.toSum().toString()).to.be.eqls('calc(0.5)');
  });

  it('should invert CSS.px() correctly.', () => {
    const number = CSS.px(2);
    const invert = number.invert();

    expect(invert.toString()).to.eqls('calc(1 / 2px)');
    expect(invert.clone().toString()).to.eqls('calc(1 / 2px)');
    expect(invert.equals(invert.clone())).to.be.true;
    expect(invert.equals(CSS.number(1))).to.be.false;
    expect(invert.equals(CSS.px(1))).to.be.false;
    expect(invert.toSum()).to.be.null;
  });
});
