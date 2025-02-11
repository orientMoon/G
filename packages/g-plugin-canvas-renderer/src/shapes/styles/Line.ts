import { singleton } from '@antv/g-lite';
import { DefaultRenderer } from './Default';
import { LineRendererContribution } from './interfaces';

@singleton({
  token: LineRendererContribution,
})
export class LineRenderer extends DefaultRenderer {}
