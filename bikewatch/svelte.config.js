import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({
			pages: '../docs',
			assets: '../docs',
			fallback: '404.html'
		}),
		paths: {
			base: process.argv.includes('dev') ? '' : '/6.C85_lab_bikeWatch'
		}
	}
};

export default config;
