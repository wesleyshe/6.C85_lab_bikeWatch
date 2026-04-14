<script>
	import { onMount } from "svelte";
	import mapboxgl from "mapbox-gl";
	import "mapbox-gl/dist/mapbox-gl.css";
	import * as d3 from "d3";

	mapboxgl.accessToken = "pk.eyJ1Ijoid2VzbGV5c2hlIiwiYSI6ImNtbnozaTJyMzA4bWsycXExcDEzMW51emoifQ.5RQJB2uUcU8BdHam7Y0FuA";

	let map = $state(null);
	let stations = $state([]);
	let mapViewChanged = $state(0);
	let timeFilter = $state(-1);
	let selectedStation = $state(null);
	let isochrone = $state(null);

	let arrivals = $state(new Map());
	let departures = $state(new Map());

	const departuresByMinute = Array.from({length: 1440}, () => []);
	const arrivalsByMinute = Array.from({length: 1440}, () => []);

	// --- Helper functions ---

	function minutesSinceMidnight(date) {
		return date.getHours() * 60 + date.getMinutes();
	}

	function filterByMinute(tripsByMinute, minute) {
		let minMinute = (minute - 60 + 1440) % 1440;
		let maxMinute = (minute + 60) % 1440;

		if (minMinute > maxMinute) {
			let beforeMidnight = tripsByMinute.slice(minMinute);
			let afterMidnight = tripsByMinute.slice(0, maxMinute);
			return beforeMidnight.concat(afterMidnight).flat();
		} else {
			return tripsByMinute.slice(minMinute, maxMinute).flat();
		}
	}

	function getCoords(station) {
		let point = new mapboxgl.LngLat(+station.Long, +station.Lat);
		let { x, y } = map.project(point);
		return { cx: x, cy: y };
	}

	// --- Derived values ---

	let timeFilterLabel = $derived(
		new Date(0, 0, 0, 0, timeFilter).toLocaleString("en", { timeStyle: "short" })
	);

	let filteredDepartures = $derived(
		timeFilter === -1
			? departures
			: d3.rollup(
					filterByMinute(departuresByMinute, timeFilter),
					(v) => v.length,
					(d) => d.start_station_id
				)
	);

	let filteredArrivals = $derived(
		timeFilter === -1
			? arrivals
			: d3.rollup(
					filterByMinute(arrivalsByMinute, timeFilter),
					(v) => v.length,
					(d) => d.end_station_id
				)
	);

	let filteredStations = $derived(
		stations.map((station) => {
			const id = station.Number;
			const arr = filteredArrivals.get(id) ?? 0;
			const dep = filteredDepartures.get(id) ?? 0;
			return {
				...station,
				arrivals: arr,
				departures: dep,
				totalTraffic: arr + dep
			};
		})
	);

	let radiusScale = $derived(
		d3
			.scaleSqrt()
			.domain([0, d3.max(stations, (d) => d.totalTraffic) || 0])
			.range(timeFilter === -1 ? [0, 25] : [3, 30])
	);

	let stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

	// --- Isochrone API ---

	const urlBase = "https://api.mapbox.com/isochrone/v1/mapbox/";
	const profile = "cycling";
	const isoMinutes = [5, 10, 15, 20];
	const contourColors = ["03045e", "0077b6", "00b4d8", "90e0ef"];

	async function getIso(lon, lat) {
		const base = `${urlBase}${profile}/${lon},${lat}`;
		const params = new URLSearchParams({
			contours_minutes: isoMinutes.join(","),
			contours_colors: contourColors.join(","),
			polygons: "true",
			access_token: mapboxgl.accessToken
		});
		const query = await fetch(`${base}?${params.toString()}`);
		isochrone = await query.json();
	}

	function geoJSONPolygonToPath(feature) {
		const path = d3.path();
		const rings = feature.geometry.coordinates;
		for (const ring of rings) {
			for (let i = 0; i < ring.length; i++) {
				const [lng, lat] = ring[i];
				const { x, y } = map.project([lng, lat]);
				if (i === 0) path.moveTo(x, y);
				else path.lineTo(x, y);
			}
			path.closePath();
		}
		return path.toString();
	}

	// --- Effects ---

	$effect(() => {
		if (map) {
			map.on("move", () => {
				mapViewChanged++;
			});
		}
	});

	$effect(() => {
		if (selectedStation) {
			getIso(+selectedStation.Long, +selectedStation.Lat);
		} else {
			isochrone = null;
		}
	});

	// --- Initialization ---

	async function initMap() {
		map = new mapboxgl.Map({
			container: "map",
			style: "mapbox://styles/mapbox/streets-v12",
			center: [-71.09415, 42.36027],
			zoom: 12
		});

		await new Promise((resolve) => map.on("load", resolve));

		const bikeLineStyle = {
			"line-color": "green",
			"line-width": 3,
			"line-opacity": 0.4
		};

		map.addSource("boston_route", {
			type: "geojson",
			data: "https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?outSR=%7B%22latestWkid%22%3A3857%2C%22wkid%22%3A102100%7D"
		});
		map.addLayer({
			id: "boston_bikes",
			type: "line",
			source: "boston_route",
			paint: bikeLineStyle
		});

		map.addSource("cambridge_route", {
			type: "geojson",
			data: "https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson"
		});
		map.addLayer({
			id: "cambridge_bikes",
			type: "line",
			source: "cambridge_route",
			paint: bikeLineStyle
		});
	}

	async function loadStationData() {
		stations = await d3.csv(
			"https://vis-society.github.io/labs/9/data/bluebikes-stations.csv"
		);
	}

	async function loadTripData() {
		let trips = await d3
			.csv("https://vis-society.github.io/labs/9/data/bluebikes-traffic-2024-03.csv")
			.then((trips) => {
				for (let trip of trips) {
					trip.started_at = new Date(trip.started_at);
					trip.ended_at = new Date(trip.ended_at);

					let startedMinutes = minutesSinceMidnight(trip.started_at);
					departuresByMinute[startedMinutes].push(trip);

					let endedMinutes = minutesSinceMidnight(trip.ended_at);
					arrivalsByMinute[endedMinutes].push(trip);
				}
				return trips;
			});

		departures = d3.rollup(
			trips,
			(v) => v.length,
			(d) => d.start_station_id
		);
		arrivals = d3.rollup(
			trips,
			(v) => v.length,
			(d) => d.end_station_id
		);

		stations = stations.map((station) => {
			let id = station.Number;
			return {
				...station,
				arrivals: arrivals.get(id) ?? 0,
				departures: departures.get(id) ?? 0,
				totalTraffic: (arrivals.get(id) ?? 0) + (departures.get(id) ?? 0)
			};
		});
	}

	onMount(() => {
		initMap();
		loadStationData().then(loadTripData);
	});
</script>

<header>
	<h1>BikeWatch</h1>
	<p class="description">Visualizing BlueBikes traffic in the Boston area</p>
	<label>
		Filter by time:
		<input type="range" min="-1" max="1440" bind:value={timeFilter} />
		{#if timeFilter !== -1}
			<time>{timeFilterLabel}</time>
		{:else}
			<em>(any time)</em>
		{/if}
	</label>
</header>

<div id="map">
	<svg>
		{#key mapViewChanged}
			{#if isochrone}
				{#each isochrone.features as feature}
					<path
						d={geoJSONPolygonToPath(feature)}
						fill="#{feature.properties.fillColor}"
						fill-opacity="0.2"
						stroke="#000000"
						stroke-opacity="0.5"
						stroke-width="1"
					>
						<title>{feature.properties.contour} minutes of biking</title>
					</path>
				{/each}
			{/if}
			{#each filteredStations as station}
				<circle
					{...getCoords(station)}
					r={radiusScale(station.totalTraffic)}
					style="--departure-ratio: {stationFlow(station.departures / station.totalTraffic || 0)}"
					class={station?.Number === selectedStation?.Number ? "selected" : ""}
					onmousedown={() => {
						selectedStation =
							selectedStation?.Number !== station.Number ? station : null;
					}}
				>
					<title
						>{station.totalTraffic} trips ({station.departures} departures, {station.arrivals}
						arrivals)</title
					>
				</circle>
			{/each}
		{/key}
	</svg>
</div>

<div class="legend">
	<span class="legend-label">Legend:</span>
	<div style="--departure-ratio: 1">More departures</div>
	<div style="--departure-ratio: 0.5">Balanced</div>
	<div style="--departure-ratio: 0">More arrivals</div>
</div>

<style>
	@import url("$lib/global.css");

	header {
		display: flex;
		gap: 1em;
		align-items: baseline;
		flex-wrap: wrap;
	}

	header h1 {
		margin: 0;
	}

	header .description {
		color: #666;
		margin: 0;
	}

	header label {
		margin-left: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	header time {
		display: block;
		font-variant-numeric: tabular-nums;
	}

	header em {
		display: block;
		color: #999;
		font-style: italic;
	}

	#map {
		flex: 1;
		min-height: 600px;
		position: relative;
	}

	#map svg {
		position: absolute;
		z-index: 1;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	#map svg circle {
		fill-opacity: 0.6;
		stroke: white;
		stroke-width: 1;
		pointer-events: auto;
		cursor: pointer;
		transition: opacity 0.2s ease;

		--color-departures: steelblue;
		--color-arrivals: darkorange;
		--color: color-mix(
			in oklch,
			var(--color-departures) calc(100% * var(--departure-ratio)),
			var(--color-arrivals)
		);
		fill: var(--color);
	}

	#map svg:has(circle.selected) circle:not(.selected) {
		opacity: 0.3;
	}

	#map svg path {
		pointer-events: auto;
	}

	.legend {
		display: flex;
		align-items: center;
		gap: 1.5em;
		margin-block: 1em;
		font-size: 0.9em;
	}

	.legend-label {
		font-weight: bold;
	}

	.legend > div {
		display: flex;
		align-items: center;
		gap: 0.4em;

		--color-departures: steelblue;
		--color-arrivals: darkorange;
		--color: color-mix(
			in oklch,
			var(--color-departures) calc(100% * var(--departure-ratio)),
			var(--color-arrivals)
		);
	}

	.legend > div::before {
		content: "";
		display: inline-block;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--color);
	}
</style>
