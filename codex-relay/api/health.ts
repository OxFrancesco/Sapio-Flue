export default {
	fetch(): Response {
		return new Response('ok\n', {
			headers: {
				'cache-control': 'no-store',
				'content-type': 'text/plain; charset=utf-8',
			},
		});
	},
};
