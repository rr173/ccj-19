// scenarios.js — 内置演示场景（与测试用例一一对应，便于手动核对）
'use strict';

function rect(x1, y1, x2, y2) {
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}

const SCENARIOS = [
  {
    id: 'two-holes',
    name: '①带两个洞的外轮廓（先洞后外圈）',
    home: { x: -25, y: -25 },
    zones: [],
    rings: [
      { id: 'part', name: '外圈 100×80', kind: 'outer', points: rect(0, 0, 100, 80) },
      { id: 'h1', name: '洞A 15×15', kind: 'hole', points: rect(20, 20, 35, 35) },
      { id: 'h2', name: '洞B 18×20', kind: 'hole', points: rect(60, 45, 78, 65) },
    ],
  },
  {
    id: 'multi-outer',
    name: '②三个互不包含外轮廓（稳定短空移）',
    home: { x: -10, y: 10 },
    zones: [],
    rings: [
      { id: 'a', name: '零件A', kind: 'outer', points: rect(0, 0, 20, 20) },
      { id: 'b', name: '零件B', kind: 'outer', points: rect(60, 0, 80, 20) },
      { id: 'c', name: '零件C', kind: 'outer', points: rect(30, 50, 50, 70) },
    ],
  },
  {
    id: 'u-slot',
    name: '③U 形窄槽（大刀致窄槽消失）',
    home: { x: -15, y: 30 },
    zones: [],
    rings: [{
      id: 'u', name: 'U形件·槽宽10', kind: 'outer',
      points: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 },
        { x: 55, y: 60 }, { x: 55, y: 20 }, { x: 45, y: 20 },
        { x: 45, y: 60 }, { x: 0, y: 60 },
      ],
    }],
    params: { toolDiameter: 4 },
  },
  {
    id: 'no-cross',
    name: '④禁止穿越区（引入线与空移绕行）',
    home: { x: -25, y: 40 },
    zones: [
      { id: 'z-block', name: '禁区·左下', type: 'no-cross', points: rect(-9, -9, 42, -1) },
      { id: 'z-block2', name: '禁区·右侧通道', type: 'no-cross', points: rect(102, 20, 128, 42) },
    ],
    rings: [
      { id: 'part', name: '板 100×80', kind: 'outer', points: rect(0, 0, 100, 80) },
      { id: 'h1', name: '洞', kind: 'hole', points: rect(35, 30, 55, 50) },
    ],
  },
  {
    id: 'start-region',
    name: '⑤起刀候选区（起刀点受限）',
    home: { x: 20, y: 110 },
    zones: [
      { id: 'sr', name: '候选区·顶面', type: 'start-region', points: rect(12, 84, 48, 98) },
    ],
    rings: [
      { id: 'part', name: '板 100×80', kind: 'outer', points: rect(0, 0, 100, 80) },
      { id: 'h1', name: '洞A', kind: 'hole', points: rect(15, 15, 30, 30) },
      { id: 'h2', name: '洞B', kind: 'hole', points: rect(62, 42, 82, 64) },
    ],
  },
  {
    id: 'sharp-bridges',
    name: '⑥细长条·桥数量不足报告',
    home: { x: -12, y: 4 },
    zones: [],
    rings: [{ id: 'thin', name: '细长条 24×8', kind: 'outer', points: rect(0, 0, 24, 8) }],
    params: { bridgeCount: 10, bridgeWidth: 3, toolDiameter: 4 },
  },
  {
    id: 'v-notch',
    name: '⑦深 V 缺口（大刀补偿自交）',
    home: { x: 50, y: -20 },
    zones: [],
    rings: [{
      id: 'v', name: 'V缺口件', kind: 'outer',
      points: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 60, y: 80 },
        { x: 50, y: 2 }, { x: 40, y: 80 }, { x: 0, y: 80 },
      ],
    }],
    params: { toolDiameter: 6, bridgeCount: 1 },
  },
  {
    id: 'nested',
    name: '⑧多层嵌套（板-洞-内嵌小岛）',
    home: { x: -20, y: -20 },
    zones: [],
    rings: [
      { id: 'p', name: '外板 120×100', kind: 'outer', points: rect(0, 0, 120, 100) },
      { id: 'h', name: '大腔洞', kind: 'hole', points: rect(15, 15, 105, 85) },
      { id: 'isl', name: '腔内小岛', kind: 'outer', points: rect(45, 35, 75, 65) },
      { id: 'ih', name: '岛内小孔', kind: 'hole', points: rect(54, 44, 66, 56) },
    ],
    params: { toolDiameter: 3 },
  },
];

if (typeof window !== 'undefined') window.SCENARIOS = SCENARIOS;
if (typeof globalThis !== 'undefined' && typeof window === 'undefined') globalThis.SCENARIOS = SCENARIOS;
