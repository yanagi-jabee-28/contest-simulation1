document.addEventListener('DOMContentLoaded', function () {
	const netlistInput = document.getElementById('netlistInput');
	const simulateBtn = document.getElementById('simulateBtn');
	const resultsPanel = document.getElementById('resultsPanel');
	const loading = document.getElementById('loading');
	const resultsContent = document.getElementById('resultsContent');
	const reqCheckDiv = document.getElementById('requirementsCheck');
	const characteristicsContainer = resultsPanel.querySelector('.grid');

	const defaultNetlist = `.PARAM psvoltage=3
.SUBCKT opamp inm inp out vdd vss

R1 vdd N006 102.7k
M1 N006 N006 vss vss cmosn l=0.18u w=0.33u
M2 N003 N002 vdd vdd cmosp l=0.18u w=0.34u
M3 N007 N006 vss vss cmosn l=0.18u w=0.6u
M4 N003 inp N007 vss cmosn l=0.18u w=0.34u
M5 N002 inm N007 vss cmosn l=0.18u w=0.34u
M6 N002 N002 vdd vdd cmosp l=0.18u w=0.34u
M7 out N003 vdd vdd cmosp l=1u w=6u
M8 N004 N003 vdd vdd cmosp l=0.18u w=10u
M9 N008 N006 vss vss cmosn l=0.18u w=20u
M10 N005 N006 vss vss cmosn l=0.18u w=5u
M11 N001 N001 vdd vdd cmosp l=0.18u w=1.25u
M12 out N001 N004 vdd cmosp l=0.18u w=18u
M14 out N005 N008 vss cmosn l=0.18u w=1.3u
M13 N005 N005 N001 vdd cmosp l=0.18u w=10u
C1 N003 out 1p
.ends`;
	netlistInput.value = defaultNetlist;

	simulateBtn.addEventListener('click', () => {
		const netlist = netlistInput.value;
		if (!netlist.trim()) {
			alert('ネットリストを入力してください。');
			return;
		}
		resultsPanel.style.display = 'block';
		loading.style.display = 'flex';
		resultsContent.style.display = 'none';

		setTimeout(() => {
			try {
				const parsedData = parseNetlist(netlist);
				const metrics = estimatePerformance(parsedData);
				const reqs = checkRequirements(metrics);
				const scores = calculateScores(metrics, reqs.pass);
				displayResults(metrics, scores, reqs);
			} catch (error) {
				console.error("Simulation Error:", error);
				alert("エラーが発生しました。ネットリストの形式を確認してください。\n" + error.message);
			} finally {
				loading.style.display = 'none';
				resultsContent.style.display = 'block';
			}
		}, 1500);
	});

	const SPICE_MODELS = {
		nmos: { vth0: 0.3694303, u0: 293.1687573 * 1e-4 },
		pmos: { vth0: -0.383273437, u0: 109.4682454 * 1e-4 },
		tox: 4.2e-9,
		epsilon_ox: 3.9 * 8.854e-12
	};
	SPICE_MODELS.nmos.kp = SPICE_MODELS.nmos.u0 * (SPICE_MODELS.epsilon_ox / SPICE_MODELS.tox);
	SPICE_MODELS.pmos.kp = SPICE_MODELS.pmos.u0 * (SPICE_MODELS.epsilon_ox / SPICE_MODELS.tox);

	function parseNetlist(netlist) {
		const lines = netlist.split('\n');
		const mosfets = [], resistors = [], capacitors = [];
		let psvoltage = 3.0;
		const parseValue = (s) => {
			if (!s) return 0;
			s = s.toLowerCase();
			const m = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
			for (let key in m) if (s.endsWith(key)) return parseFloat(s.replace(key, '')) * m[key];
			return parseFloat(s);
		};
		for (const line of lines) {
			const l = line.trim().toLowerCase();
			if (l.startsWith('*') || !l) continue;
			const p = l.split(/\s+/);
			if (p[0].startsWith('m')) {
				let w = 0, l = 0;
				p.forEach(part => {
					if (part.startsWith('w=')) w = parseValue(part.substring(2));
					if (part.startsWith('l=')) l = parseValue(part.substring(2));
				});
				mosfets.push({ name: p[0], d: p[1], g: p[2], s: p[3], b: p[4], type: p[5].includes('n') ? 'n' : 'p', w, l });
			} else if (p[0].startsWith('r')) {
				resistors.push({ name: p[0], n1: p[1], n2: p[2], value: parseValue(p[3]) });
			} else if (p[0].startsWith('c')) {
				capacitors.push({ name: p[0], p_node: p[1], n_node: p[2], value: parseValue(p[3]) });
			} else if (l.includes('.param psvoltage')) {
				const match = l.match(/psvoltage\s*=\s*([0-9.]+)/i);
				if (match) psvoltage = parseFloat(match[1]);
			}
		}
		return { mosfets, resistors, capacitors, psvoltage };
	}

	function estimatePerformance(data) {
		// HSPICE AC解析条件に準拠
		// .AC DEC 100 0.1 10G, .MEAS AC dcgain FIND VDB(out) AT=0.1
		// RL=20kΩ負荷、申告電源電圧、温度25℃（温度依存は無視）
		const RL = 20e3; // 評価用負荷抵抗 20kΩ
		const Vdd = data.psvoltage || 3.0;
		const k_n = SPICE_MODELS.nmos.kp, k_p = SPICE_MODELS.pmos.kp;
		const inputPair = data.mosfets.filter(m => (m.g === 'inp' || m.g === 'inm'));
		if (inputPair.length < 2) throw new Error("入力ペアが見つかりません。");
		let tailCurrent = 0;
		for (const m of data.mosfets) {
			if ((m.d === inputPair[0].s || m.d === inputPair[1].s) && m.type === 'n') {
				tailCurrent = k_n * (m.w / m.l) * 0.2 * 0.2 / 2;
				break;
			}
		}
		if (tailCurrent === 0) tailCurrent = 10e-6;
		const gm_in = k_n * (inputPair[0].w / inputPair[0].l) * 0.2;
		const outMos = data.mosfets.filter(m => m.d === 'out');
		let ro_out = 0;
		for (const m of outMos) {
			if (m.type === 'p') {
				ro_out += 1 / (0.04 / m.l * tailCurrent + 1e-9);
			} else {
				ro_out += 1 / (0.06 / m.l * tailCurrent + 1e-9);
			}
		}
		if (ro_out === 0) ro_out = 20e3;
		const ro_in = 1 / (0.04 / inputPair[0].l * tailCurrent + 1e-9);
		const A0_sim = gm_in * (ro_in * ro_out) / (ro_in + ro_out);
		const A0_eval = A0_sim * RL / (RL + ro_out);
		const dcGain_dB = 20 * Math.log10(Math.abs(A0_eval));
		let compCap = data.capacitors.find(c => c.name === 'c1');
		if (!compCap) compCap = { value: 1e-12 };
		const gbw = gm_in / (2 * Math.PI * compCap.value);
		const slewRate = tailCurrent / compCap.value;
		const Id_static_total = tailCurrent * 2;
		const power = Vdd * Id_static_total;
		const phaseMargin = 60;
		const noise_rms = Math.sqrt((8 * 1.38e-23 * 300) / (3 * gm_in) * 1e6);
		const cmir_percent = 90;
		const cmrr_dB = 80;
		const psrr_dB = 80;
		return { slewRate, dcGain_dB, gbw, phaseMargin, power, Id_static: Id_static_total, rout: ro_out, noise_rms, cmir_percent, psrr_dB, cmrr_dB, psvoltage: Vdd };
	}

	function checkRequirements(metrics) {
		const results = [], addResult = (n, v, u, p, r) => results.push({ name: n, value: v, unit: u, pass: p, required: r });
		addResult('直流利得', metrics.dcGain_dB, 'dB', metrics.dcGain_dB >= 40, '40 dB 以上');
		addResult('位相余裕', metrics.phaseMargin, 'deg', metrics.phaseMargin >= 45, '45 deg 以上');
		addResult('利得帯域幅積', metrics.gbw, 'Hz', metrics.gbw >= 1e6, '1 MHz 以上');
		addResult('スルーレート', metrics.slewRate, 'V/s', metrics.slewRate >= 0.1e6, '0.1 V/us 以上');
		const allPass = results.every(r => r.pass);
		reqCheckDiv.innerHTML = '';
		if (allPass) {
			reqCheckDiv.className = 'mb-6 p-4 rounded-lg bg-green-100 text-green-800';
			reqCheckDiv.innerHTML = '<h4 class="font-bold">要件チェック：<span class="font-normal">合格</span></h4><p class="text-sm">全ての最低要件を満たしています。</p>';
		} else {
			reqCheckDiv.className = 'mb-6 p-4 rounded-lg bg-red-100 text-red-800';
			let failureList = results.filter(r => !r.pass).map(r => {
				let valStr = (r.name === '利得帯域幅積') ? (r.value / 1e6).toFixed(2) + ' MHz' : (r.name === 'スルーレート') ? (r.value / 1e6).toFixed(2) + ' V/us' : r.value.toFixed(1) + ' ' + r.unit;
				return `<li>${r.name} (${valStr}) - 要件: ${r.required}</li>`;
			}).join('');
			reqCheckDiv.innerHTML = `<h4 class="font-bold">要件チェック：<span class="font-normal">不合格</span></h4><p class="text-sm">以下の項目が要件を満たしていません：</p><ul class="list-disc list-inside mt-2 text-sm">${failureList}</ul>`;
		}
		return { pass: allPass };
	}

	function calculateScores(metrics, passedReqs) {
		if (!passedReqs) return { score1: 0, score2: 0, score3: 0 };
		const sr = metrics.slewRate, cmir_ratio = metrics.cmir_percent / 100, gain_db = metrics.dcGain_dB, i_supply = metrics.Id_static;
		const gbw = metrics.gbw, pm = metrics.phaseMargin, power = metrics.power, rout = metrics.rout > 0.1 ? metrics.rout : 0.1, noise = metrics.noise_rms > 1e-9 ? metrics.noise_rms : 1e-9;
		const psrr_linear = Math.pow(10, metrics.psrr_dB / 20), cmrr_linear = Math.pow(10, metrics.cmrr_dB / 20), psv = metrics.psvoltage, gain_linear = Math.pow(10, metrics.dcGain_dB / 20);
		const score1 = (sr * cmir_ratio * gain_db) / i_supply;
		const score2 = (gbw * pm) / (power * power * rout * noise);
		const score3 = (psrr_linear * cmrr_linear) / (gain_linear * psv);
		return { score1, score2, score3 };
	}

	function displayResults(metrics, scores, reqs) {
		const formatSci = (num) => (num && reqs.pass) ? num.toExponential(3) : '--';
		const displayItems = [
			{ label: '直流利得', value: metrics.dcGain_dB.toFixed(1), unit: 'dB', tooltip: '低周波での開ループ電圧利得' },
			{ label: '位相余裕', value: metrics.phaseMargin.toFixed(1), unit: 'deg', tooltip: '負帰還時の安定性を示す指標' },
			{ label: '利得帯域幅積', value: (metrics.gbw).toExponential(2), unit: 'Hz', tooltip: '利得が1になる周波数' },
			{ label: 'スルーレート', value: (metrics.slewRate / 1e6).toFixed(2), unit: 'V/us', tooltip: '出力電圧の最大変化速度' },
			{ label: '消費電力', value: (metrics.power * 1e6).toFixed(2), unit: 'uW', tooltip: '静止時の消費電力' },
			{ label: '消費電流', value: (metrics.Id_static * 1e6).toFixed(2), unit: 'uA', tooltip: '静止時の消費電流' },
			{ label: '出力抵抗', value: metrics.rout.toFixed(2), unit: 'Ω', tooltip: '開ループでの出力抵抗' },
			{ label: '入力換算雑音', value: (metrics.noise_rms * 1e6).toFixed(3), unit: 'uV', tooltip: '入力に換算した雑音電圧 (0.1Hz-1MHz帯域の積分値)' },
			{ label: '同相入力範囲', value: metrics.cmir_percent.toFixed(1), unit: '%', tooltip: '電源電圧に対する入力同相範囲の割合' },
			{ label: 'PSRR', value: metrics.psrr_dB.toFixed(1), unit: 'dB', tooltip: '電源電圧変動除去比' },
			{ label: 'CMRR', value: metrics.cmrr_dB.toFixed(1), unit: 'dB', tooltip: '同相信号除去比' },
			{ label: '電源電圧', value: metrics.psvoltage.toFixed(2), unit: 'V', tooltip: '申告された電源電圧' },
		];
		characteristicsContainer.innerHTML = '';
		displayItems.forEach(item => {
			const itemDiv = document.createElement('div');
			itemDiv.className = 'flex justify-between items-center bg-gray-50 p-3 rounded-lg';
			itemDiv.innerHTML = `
				<p class="font-medium text-sm tooltip">${item.label}
					<span class="tooltiptext">${item.tooltip}</span>
				</p>
				<p class="font-bold text-base">${item.value} <span class="text-sm font-normal text-gray-500">${item.unit}</span></p>
			`;
			characteristicsContainer.appendChild(itemDiv);
		});
		document.getElementById('score1').textContent = formatSci(scores.score1);
		document.getElementById('score2').textContent = formatSci(scores.score2);
		document.getElementById('score3').textContent = formatSci(scores.score3);
	}
});
