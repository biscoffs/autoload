(function() {
    'use strict';

    var loading = false;
    var loadMoreButton = document.querySelector('#main-content-general_search > div.tiktok-1fwlm1o-DivPanelContainer.ea3pfar2 > div.tiktok-14xbhsu-DivMoreContainer.e17vxm6m0 > button');

    if (loadMoreButton) {
        loadMoreButton.style.display = 'none';

        window.addEventListener('scroll', function() {
            if (!loading && (window.innerHeight + window.scrollY) >= document.body.offsetHeight) {
                loading = true;
                loadMoreButton.click();
                setTimeout(function() {
                    loading = false;
                }, 2000);
            }
        });
    }
})();
