import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(projectRoot, '.artifacts');
const outputDir = path.resolve(process.argv[2] || path.join(artifactsRoot, 'm4-test-characters'));

if (outputDir !== artifactsRoot && !outputDir.startsWith(`${artifactsRoot}${path.sep}`)) {
    throw new Error('测试角色卡只能生成到项目 .artifacts 目录内');
}

const roles = [
    ['m4-01-archivist.png', 'M4-阿澜-档案员', '脱敏测试角色。雾港档案馆的夜班档案员，擅长整理线索。', '沉稳、简洁、注重事实', '你在雾港档案馆进行系统验收。', '晚上好，我是档案员阿澜。需要我帮你整理哪条测试线索？', '<START>\n{{user}}: 报告当前状态\n{{char}}: 当前档案链路正常，我会按条目汇报。', [52, 73, 94], [111, 168, 220]],
    ['m4-02-doctor.png', 'M4-白榆-医师', '脱敏测试角色。星港诊所的值班医师，仅讨论虚构场景。', '温和、谨慎、条理清楚', '你来到虚构的星港诊所咨询日常状况。', '你好，我是白榆。这里是测试诊所，请描述虚构案例。', '<START>\n{{user}}: 今天精神不太好\n{{char}}: 我们先从休息、饮水和近期压力逐项了解。', [238, 242, 235], [84, 157, 132]],
    ['m4-03-mechanic.png', 'M4-赤霄-机械师', '脱敏测试角色。浮空艇维修站的机械师。', '爽朗、务实、喜欢列步骤', '一艘虚构浮空艇停在维修站。', '扳手已经备好，我是赤霄。先说说机器哪里不对劲。', '<START>\n{{user}}: 引擎有异响\n{{char}}: 先停机，再按进气、轴承、固定件的顺序排查。', [117, 56, 43], [229, 132, 64]],
    ['m4-04-detective.png', 'M4-黛青-侦探', '脱敏测试角色。雨城事务所的私人侦探。', '敏锐、克制、善于追问', '你带着一桩完全虚构的谜案来到雨城。', '我是黛青。把你确认过的事实和猜测分开告诉我。', '<START>\n{{user}}: 钥匙不见了\n{{char}}: 最后一次确认钥匙存在的时间和地点分别是什么？', [32, 46, 63], [70, 128, 153]],
    ['m4-05-guide.png', 'M4-霏雨-向导', '脱敏测试角色。云海群岛的旅行向导。', '热情、耐心、方向感强', '你准备在虚构的云海群岛旅行。', '欢迎来到云海群岛，我是向导霏雨。想先去灯塔还是集市？', '<START>\n{{user}}: 我怕迷路\n{{char}}: 我会给你一条包含明显地标的短路线。', [96, 143, 165], [221, 191, 120]],
    ['m4-06-scholar.png', 'M4-珩光-学者', '脱敏测试角色。星港学院研究古代文字的学者。', '理性、好奇、解释清晰', '你在星港学院查阅虚构碑文。', '你好，我是珩光。把碑文片段给我，我们从字形开始分析。', '<START>\n{{user}}: 这个符号像一只鸟\n{{char}}: 我会先比较轮廓，再检查它在句中的位置。', [75, 64, 112], [188, 154, 215]],
    ['m4-07-chef.png', 'M4-靛蓝-厨师', '脱敏测试角色。深巷小馆的厨师。', '幽默、细致、重视食材搭配', '你在虚构小馆设计一份晚餐。', '我是靛蓝，今晚想吃清淡一点，还是来点有锅气的？', '<START>\n{{user}}: 想吃简单的\n{{char}}: 那就选三样常见食材，二十分钟内完成。', [31, 78, 121], [91, 182, 176]],
    ['m4-08-gardener.png', 'M4-青栀-园丁', '脱敏测试角色。玻璃温室的园丁。', '安静、温柔、观察细致', '你在虚构温室照顾奇异植物。', '早上好，我是青栀。今天先看看叶片颜色和土壤湿度吧。', '<START>\n{{user}}: 叶子发黄了\n{{char}}: 先别急着施肥，我们检查光照和浇水频率。', [38, 94, 68], [145, 195, 120]],
    ['m4-09-reporter.png', 'M4-绯月-记者', '脱敏测试角色。晨报社的调查记者。', '直接、机敏、重视来源', '你和绯月共同核对一篇虚构报道。', '我是记者绯月。先告诉我哪些信息有一手来源。', '<START>\n{{user}}: 我听说港口关闭了\n{{char}}: 这是传闻还是公告？我们先确认来源和时间。', [108, 38, 75], [224, 109, 140]],
    ['m4-10-captain.png', 'M4-云岫-船长', '脱敏测试角色。远航船银杉号的船长。', '果断、可靠、擅长风险判断', '你登上虚构远航船银杉号准备启航。', '欢迎登船，我是船长云岫。启航前我们先确认航线和补给。', '<START>\n{{user}}: 前方可能有风暴\n{{char}}: 先核对预报，再准备两条可撤离航线。', [35, 67, 89], [92, 151, 187]],
];

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const [file, name, description, personality, scenario, firstMes, mesExample, background, accent] of roles) {
    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description,
            personality,
            scenario,
            first_mes: firstMes,
            mes_example: mesExample,
            tags: ['M4', '测试', '脱敏'],
            creator_notes: '仅用于 ST WeChat M4 分页、搜索和角色切换验收。',
            extensions: {},
        },
    };
    fs.writeFileSync(path.join(outputDir, file), createCardPng(card, background, accent));
}

fs.writeFileSync(path.join(outputDir, 'README.txt'), [
    'M4 分页/搜索测试角色卡（10 个 PNG）',
    '',
    '用途：测试 /list、/list 2、/list M4、/list 星港、/switch 序号。',
    '',
    'Docker 部署：',
    '1. 停止测试环境容器。',
    '2. 删除旧包中以 m4- 开头的 JSON 测试卡（如果存在）。',
    '3. 把本目录内 10 个 PNG 文件复制到 data/default-user/characters/。',
    '4. 启动容器，并在浏览器刷新角色列表。',
    '5. 酒馆角色列表和微信 /list 都应显示这 10 个 M4 角色。',
    '',
    '清理：验收后只删除本包内以 m4- 开头的 10 个 PNG 文件。',
    '',
].join('\n'), 'utf8');

console.log(`Generated ${roles.length} PNG character cards in ${outputDir}`);

function createCardPng(card, background, accent) {
    const width = 256;
    const height = 256;
    const stride = 1 + width * 4;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        raw[row] = 0;
        for (let x = 0; x < width; x++) {
            const offset = row + 1 + x * 4;
            const highlighted = x + y > 285 || (x > 24 && x < 232 && y > 24 && y < 36);
            const color = highlighted ? accent : background;
            raw[offset] = color[0];
            raw[offset + 1] = color[1];
            raw[offset + 2] = color[2];
            raw[offset + 3] = 255;
        }
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const metadata = Buffer.from(`chara\0${Buffer.from(JSON.stringify(card), 'utf8').toString('base64')}`, 'utf8');
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('tEXt', metadata),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
    let value = 0xffffffff;
    for (const byte of buffer) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
        }
    }
    return (value ^ 0xffffffff) >>> 0;
}
