/*
 * Copyright (c) 2022, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import React, {useEffect, useState} from 'react'
import PropTypes from 'prop-types'
import {useHistory, useLocation, useParams} from 'react-router-dom'
import {FormattedMessage, useIntl} from 'react-intl'
import {Helmet} from 'react-helmet'

// Components
import {
    Box,
    Flex,
    SimpleGrid,
    Grid,
    GridItem,
    Select,
    Spacer,
    Text,
    FormControl,
    Stack,
    useDisclosure,
    Button,
    Modal,
    ModalHeader,
    ModalBody,
    ModalFooter,
    ModalContent,
    ModalCloseButton,
    ModalOverlay,
    Drawer,
    DrawerBody,
    DrawerHeader,
    DrawerOverlay,
    DrawerContent,
    DrawerCloseButton,
    useBreakpointValue
} from '@chakra-ui/react'

// Project Components
import Pagination from '../../components/pagination'
import ProductTile, {Skeleton as ProductTileSkeleton} from '../../components/product-tile'
import {HideOnDesktop} from '../../components/responsive'
import Refinements from './partials/refinements'
import SelectedRefinements from './partials/selected-refinements'
import EmptySearchResults from './partials/empty-results'
import PageHeader from './partials/page-header'

// Amplience Components
import AmplienceWrapper from '../../components/amplience/wrapper'
import _ from 'lodash'

// Icons
import {FilterIcon, ChevronDownIcon} from '../../components/icons'

// Hooks
import {useLimitUrls, useSortUrls, useSearchParams} from '../../hooks'
import {useToast} from '../../hooks/use-toast'
import useWishlist from '../../hooks/use-wishlist'
import {parse as parseSearchParams} from '../../hooks/use-search-params'
import {useCategories} from '../../hooks/use-categories'
import useMultiSite from '../../hooks/use-multi-site'

// Others
import {HTTPNotFound} from 'pwa-kit-react-sdk/ssr/universal/errors'

// Constants
import {
    DEFAULT_LIMIT_VALUES,
    API_ERROR_MESSAGE,
    MAX_CACHE_AGE,
    TOAST_ACTION_VIEW_WISHLIST,
    TOAST_MESSAGE_ADDED_TO_WISHLIST,
    TOAST_MESSAGE_REMOVED_FROM_WISHLIST
} from '../../constants'
import useNavigation from '../../hooks/use-navigation'
import LoadingSpinner from '../../components/loading-spinner'
import {resolveSiteFromUrl} from '../../utils/site-utils'
import {getTargetLocale} from '../../utils/locale'
import {useMemo} from 'react'
import {buildUrlSet} from '../../utils/url'
import {useAmpRtv} from '../../utils/amplience/rtv'
import {defaultAmpClient} from '../../amplience-api'
import GridItemHero from '../../components/amplience/hero/gridItemHero'

const inGridComponents = {
    'https://sfcc.com/components/hero': GridItemHero
}

// NOTE: You can ignore certain refinements on a template level by updating the below
// list of ignored refinements.
const REFINEMENT_DISALLOW_LIST = ['c_isNew']

function getIdsForContent(item) {
    return {id: item.id}
}

const calculatePageOffsets = (pageSize, totalCount, ampSlots, isMobile) => {
    // Amplience slots reduce the page size of sfcc content.
    const pages = []
    let processed = 0
    let offset = 0

    const pageNumber = (index) => {
        return Math.floor(index / pageSize)
    }

    const fillPages = (upTo) => {
        const uptoBasePage = pageNumber(upTo + offset)

        while (pages.length <= uptoBasePage) {
            pages.push(pages.length * pageSize - offset)
        }

        processed = upTo
    }

    const skipContent = (size) => {
        // If this splits a page, create one.
        offset += size

        fillPages(processed)
    }

    if (ampSlots) {
        for (let i = 0; i < ampSlots.length; i++) {
            const slot = ampSlots[i]

            fillPages(slot.position)

            const size = isMobile ? 1 : Number(slot.cols) * Number(slot.rows)

            skipContent(size)
        }
    }

    fillPages(totalCount)

    return pages
}

const enrichResults = (productSearchResults, pageSize, ampSlots, pages, isMobile) => {
    if (productSearchResults?.hits) {
        const offset = productSearchResults.offset
        const total = productSearchResults.total

        let pageId = pages.findIndex((pageIndex) => pageIndex > offset) - 1
        if (pageId == -2) {
            pageId = pages.length - 1
        }

        const pageBase = pageId * pageSize

        const sfccCount = (pages[pageId + 1] ?? total) - pages[pageId]
        const items = productSearchResults.hits.slice(0, sfccCount)

        let reservedSpaces = 0

        if (ampSlots) {
            for (let slot of ampSlots) {
                const pos = slot.position

                if (pos < pageBase) {
                    continue
                }

                if (pos >= pageBase + pageSize) {
                    break
                }

                // Place content up to the given slot.
                const size = isMobile ? 1 : Number(slot.rows) * Number(slot.cols)

                slot.isAmplience = true

                items.splice(pos - pageBase - reservedSpaces, 0, slot)

                reservedSpaces += size - 1
            }
        }

        return items
    }

    return productSearchResults?.hits
}

/*
 * Generate a memoized list of page size urls influenced by inline amplience content.
 * Changing the page size will reset the offset to zero to simplify things.
 */
export const useAmpPageUrls = ({total = 0, limit, pageOffsets}) => {
    const location = useLocation()
    const [searchParams] = useSearchParams()
    const _limit = limit || searchParams.limit

    return useMemo(() => {
        return buildUrlSet(`${location.pathname}${location.search}`, 'offset', pageOffsets)
    }, [location.pathname, location.search, _limit, total, pageOffsets])
}

/*
 * This is a simple product listing page. It displays a paginated list
 * of product hit objects. Allowing for sorting and filtering based on the
 * allowable filters and sort refinements.
 */
const ProductList = (props) => {
    const {
        searchQuery,
        productSearchResult,
        // eslint-disable-next-line react/prop-types
        staticContext,
        location,
        isLoading,
        ampTopContent: initialAmpTopContent,
        ampBottomContent: initialAmpBottomContent,
        ampSlots: initialAmpSlots,
        ...rest
    } = props
    const {isOpen, onOpen, onClose} = useDisclosure()
    const {formatMessage} = useIntl()
    const navigate = useNavigation()
    const history = useHistory()
    const params = useParams()
    const {categories} = useCategories()
    const toast = useToast()
    const {locale} = useMultiSite()
    const [searchParams, {stringify: stringifySearchParams}] = useSearchParams()

    const limitUrls = useLimitUrls()
    const wishlist = useWishlist()

    const [ampSlots, setAmpSlots] = useState(initialAmpSlots)
    const [ampTopContent, setAmpTopContent] = useState(initialAmpTopContent)
    const [ampBottomContent, setAmpBottomContent] = useState(initialAmpBottomContent)
    const [sortOpen, setSortOpen] = useState(false)
    const [wishlistLoading, setWishlistLoading] = useState([])
    const [filtersLoading, setFiltersLoading] = useState(false)

    const {total, sortingOptions} = productSearchResult || {}
    const basePath = `${location.pathname}${location.search}`
    const category = !searchQuery && params.categoryId ? categories[params.categoryId] : undefined

    const isMobile = useBreakpointValue({base: true, md: false})
    const sortUrls = useSortUrls({options: sortingOptions})

    const pageOffsets = useMemo(() => {
        return calculatePageOffsets(searchParams.limit, total, ampSlots, isMobile)
    }, [searchParams.limit, total, ampSlots, isMobile])

    const pageUrls = useAmpPageUrls({total, pageOffsets})

    const showNoResults = !isLoading && productSearchResult && !productSearchResult?.hits

    useAmpRtv(
        async (model) => {
            setAmpSlots(model.content?.gridItem)

            const childContentPromise = async () => {
                if (!model.content.topContent) return []
                const topContentIDs = model.content?.topContent.map(getIdsForContent) || []
                if (topContentIDs && topContentIDs.length) {
                    const rtvTopContent = await defaultAmpClient.fetchContent(topContentIDs, {
                        locale: locale + ',*'
                    })
                    return rtvTopContent
                } else {
                    return []
                }
            }
            const dataForTopContent = await childContentPromise()
            setAmpTopContent(dataForTopContent)
            setAmpBottomContent(model.content.bottomContent)
        },
        undefined,
        [initialAmpSlots, initialAmpBottomContent, initialAmpTopContent]
    )

    useEffect(() => {
        setAmpSlots(initialAmpSlots)
        setAmpTopContent(initialAmpTopContent)
        setAmpBottomContent(initialAmpBottomContent)
    }, [initialAmpSlots, initialAmpTopContent, initialAmpBottomContent])

    useEffect(() => {
        isLoading && window.scrollTo(0, 0)
        setFiltersLoading(isLoading)
    }, [isLoading])

    useEffect(() => {
        let dist = Infinity
        let pageId = 0

        for (let i = 0; i < pageOffsets.length; i++) {
            const myDist = Math.abs(pageOffsets[i] - searchParams.offset)

            if (myDist < dist) {
                dist = myDist
                pageId = i
            }
        }

        if (pageOffsets[pageId] !== searchParams.offset) {
            const searchParamsCopy = {...searchParams, offset: pageOffsets[pageId]}
            navigate(`/category/${params.categoryId}?${stringifySearchParams(searchParamsCopy)}`)
        }
    }, [isMobile, searchParams.offset])

    // TODO: DRY this handler when intl provider is available globally
    const addItemToWishlist = async (product) => {
        try {
            setWishlistLoading([...wishlistLoading, product.productId])
            await wishlist.createListItem({
                id: product.productId,
                quantity: 1
            })
            toast({
                title: formatMessage(TOAST_MESSAGE_ADDED_TO_WISHLIST, {quantity: 1}),
                status: 'success',
                action: (
                    <Button variant="link" onClick={() => navigate('/account/wishlist')}>
                        {formatMessage(TOAST_ACTION_VIEW_WISHLIST)}
                    </Button>
                )
            })
        } catch {
            toast({
                title: formatMessage(API_ERROR_MESSAGE),
                status: 'error'
            })
        } finally {
            setWishlistLoading(wishlistLoading.filter((id) => id !== product.productId))
        }
    }

    // TODO: DRY this handler when intl provider is available globally
    const removeItemFromWishlist = async (product) => {
        try {
            setWishlistLoading([...wishlistLoading, product.productId])
            await wishlist.removeListItemByProductId(product.productId)
            toast({
                title: formatMessage(TOAST_MESSAGE_REMOVED_FROM_WISHLIST),
                status: 'success'
            })
        } catch {
            toast({
                title: formatMessage(API_ERROR_MESSAGE),
                status: 'error'
            })
        } finally {
            setWishlistLoading(wishlistLoading.filter((id) => id !== product.productId))
        }
    }

    const toggleFilter = (value, attributeId, selected, allowMultiple = true) => {
        const searchParamsCopy = {...searchParams}

        delete searchParamsCopy.offset
        if (!allowMultiple) {
            delete searchParamsCopy.refine[attributeId]

            if (!selected) {
                searchParamsCopy.refine[attributeId] = value.value
            }
        } else {
            let attributeValue = searchParamsCopy.refine[attributeId] || []
            let values = Array.isArray(attributeValue) ? attributeValue : attributeValue.split('|')

            if (!selected) {
                values.push(value.value)
            } else {
                values = values?.filter((v) => v !== value.value)
            }

            searchParamsCopy.refine[attributeId] = values

            if (searchParamsCopy.refine[attributeId].length === 0) {
                delete searchParamsCopy.refine[attributeId]
            }
        }

        navigate(`/category/${params.categoryId}?${stringifySearchParams(searchParamsCopy)}`)
    }

    const resetFilters = () => {
        navigate(window.location.pathname)
    }

    const selectedSortingOptionLabel =
        productSearchResult?.sortingOptions?.find(
            (option) => option.id === productSearchResult?.selectedSortingOption
        ) || productSearchResult?.sortingOptions?.[0]

    const results = enrichResults(
        productSearchResult,
        searchParams.limit,
        ampSlots,
        pageOffsets,
        isMobile
    )

    return (
        <Box
            className="sf-product-list-page"
            data-testid="sf-product-list-page"
            layerStyle="page"
            paddingTop={{base: 6, lg: 8}}
            {...rest}
        >
            <Helmet>
                <title>{category?.pageTitle}</title>
                <meta name="description" content={category?.pageDescription} />
                <meta name="keywords" content={category?.pageKeywords} />
            </Helmet>
            {showNoResults ? (
                <EmptySearchResults searchQuery={searchQuery} category={category} />
            ) : (
                <>
                    {/* Header */}
                    {/* Amplience - Top Content SSR */}
                    {ampTopContent &&
                        _.compact(ampTopContent).map((content, ind) => (
                            <AmplienceWrapper key={ind} content={content}></AmplienceWrapper>
                        ))}
                    <Stack
                        display={{base: 'none', lg: 'flex'}}
                        direction="row"
                        justify="flex-start"
                        align="flex-start"
                        spacing={4}
                        marginBottom={6}
                    >
                        <Flex align="left" width="287px">
                            <PageHeader
                                searchQuery={searchQuery}
                                category={category}
                                productSearchResult={productSearchResult}
                                isLoading={isLoading}
                            />
                        </Flex>
                        <Box flex={1} paddingTop={'45px'}>
                            <SelectedRefinements
                                filters={productSearchResult?.refinements}
                                toggleFilter={toggleFilter}
                                selectedFilterValues={productSearchResult?.selectedRefinements}
                            />
                        </Box>

                        <Box paddingTop={'45px'}>
                            <Sort
                                sortUrls={sortUrls}
                                productSearchResult={productSearchResult}
                                basePath={basePath}
                            />
                        </Box>
                    </Stack>

                    <HideOnDesktop>
                        <Stack spacing={6}>
                            <PageHeader
                                searchQuery={searchQuery}
                                category={category}
                                productSearchResult={productSearchResult}
                                isLoading={isLoading}
                            />
                            <Stack
                                display={{base: 'flex', md: 'none'}}
                                direction="row"
                                justify="flex-start"
                                align="center"
                                spacing={1}
                                height={12}
                                borderColor="gray.100"
                            >
                                <Flex align="center">
                                    <Button
                                        fontSize="sm"
                                        colorScheme="black"
                                        variant="outline"
                                        marginRight={2}
                                        display="inline-flex"
                                        leftIcon={<FilterIcon boxSize={5} />}
                                        onClick={onOpen}
                                    >
                                        <FormattedMessage
                                            defaultMessage="Filter"
                                            id="product_list.button.filter"
                                        />
                                    </Button>
                                </Flex>
                                <Flex align="center">
                                    <Button
                                        maxWidth="245px"
                                        fontSize="sm"
                                        marginRight={2}
                                        colorScheme="black"
                                        variant="outline"
                                        display="inline-flex"
                                        rightIcon={<ChevronDownIcon boxSize={5} />}
                                        onClick={() => setSortOpen(true)}
                                    >
                                        {formatMessage(
                                            {
                                                id: 'product_list.button.sort_by',
                                                defaultMessage: 'Sort By: {sortOption}'
                                            },
                                            {
                                                sortOption: selectedSortingOptionLabel?.label
                                            }
                                        )}
                                    </Button>
                                </Flex>
                            </Stack>
                        </Stack>
                        <Box marginBottom={4}>
                            <SelectedRefinements
                                filters={productSearchResult?.refinements}
                                toggleFilter={toggleFilter}
                                selectedFilterValues={productSearchResult?.selectedRefinements}
                            />
                        </Box>
                    </HideOnDesktop>
                    {/* Body  */}
                    <Grid templateColumns={{base: '1fr', md: '280px 1fr'}} columnGap={6}>
                        <Stack display={{base: 'none', md: 'flex'}}>
                            <Refinements
                                isLoading={filtersLoading}
                                toggleFilter={toggleFilter}
                                filters={productSearchResult?.refinements}
                                selectedFilters={searchParams.refine}
                            />
                        </Stack>
                        <Box>
                            <SimpleGrid
                                columns={[2, 2, 3, 3]}
                                spacingX={4}
                                spacingY={{base: 12, lg: 16}}
                            >
                                {isLoading || !productSearchResult
                                    ? new Array(searchParams.limit)
                                          .fill(0)
                                          .map((value, index) => (
                                              <ProductTileSkeleton key={index} />
                                          ))
                                    : results.map((item, index) => {
                                          if (item.isAmplience) {
                                              // Amplience content tile

                                              return (
                                                  <GridItem
                                                      key={index}
                                                      colEnd={{
                                                          base: `span 1`,
                                                          md: `span ${item.cols}`
                                                      }}
                                                      rowEnd={{
                                                          base: `span 1`,
                                                          md: `span ${item.rows}`
                                                      }}
                                                      display="flex"
                                                  >
                                                      <AmplienceWrapper
                                                          fetch={{id: item.content?.id}}
                                                          components={inGridComponents}
                                                          cols={isMobile ? 1 : item.cols}
                                                          rows={isMobile ? 1 : item.rows}
                                                      ></AmplienceWrapper>
                                                  </GridItem>
                                              )
                                          } else {
                                              const productSearchItem = item
                                              const productId = productSearchItem.productId
                                              const isInWishlist = !!wishlist.findItemByProductId(
                                                  productId
                                              )

                                              return (
                                                  <ProductTile
                                                      data-testid={`sf-product-tile-${productSearchItem.productId}`}
                                                      key={productSearchItem.productId}
                                                      product={productSearchItem}
                                                      enableFavourite={true}
                                                      isFavourite={isInWishlist}
                                                      onFavouriteToggle={(isFavourite) => {
                                                          const action = isFavourite
                                                              ? addItemToWishlist
                                                              : removeItemFromWishlist
                                                          return action(productSearchItem)
                                                      }}
                                                      dynamicImageProps={{
                                                          widths: [
                                                              '50vw',
                                                              '50vw',
                                                              '20vw',
                                                              '20vw',
                                                              '25vw'
                                                          ]
                                                      }}
                                                  />
                                              )
                                          }
                                      })}
                            </SimpleGrid>
                            {/* Footer */}
                            <Flex
                                justifyContent={['center', 'center', 'flex-start']}
                                paddingTop={8}
                            >
                                <Pagination currentURL={basePath} urls={pageUrls} />

                                {/*
                            Our design doesn't call for a page size select. Show this element if you want
                            to add one to your design.
                        */}
                                <Select
                                    display="none"
                                    value={basePath}
                                    onChange={({target}) => {
                                        history.push(target.value)
                                    }}
                                >
                                    {limitUrls.map((href, index) => (
                                        <option key={href} value={href}>
                                            {DEFAULT_LIMIT_VALUES[index]}
                                        </option>
                                    ))}
                                </Select>
                            </Flex>
                        </Box>
                    </Grid>
                    <Spacer height={6} />
                    {/* Amplience - Bottom Content CSR */}
                    {ampBottomContent &&
                        _.compact(ampBottomContent).map((content, ind) => (
                            <AmplienceWrapper key={ind} fetch={{id: content.id}}></AmplienceWrapper>
                        ))}
                </>
            )}
            <Modal
                isOpen={isOpen}
                onClose={onClose}
                size="full"
                motionPreset="slideInBottom"
                scrollBehavior="inside"
            >
                <ModalOverlay />
                <ModalContent top={0} marginTop={0}>
                    <ModalHeader>
                        <Text fontWeight="bold" fontSize="2xl">
                            <FormattedMessage
                                defaultMessage="Filter"
                                id="product_list.modal.title.filter"
                            />
                        </Text>
                    </ModalHeader>
                    <ModalCloseButton />
                    <ModalBody py={4}>
                        {filtersLoading && <LoadingSpinner />}
                        <Refinements
                            toggleFilter={toggleFilter}
                            filters={productSearchResult?.refinements}
                            selectedFilters={productSearchResult?.selectedRefinements}
                        />
                    </ModalBody>

                    <ModalFooter
                        // justify="space-between"
                        display="block"
                        width="full"
                        borderTop="1px solid"
                        borderColor="gray.100"
                        paddingBottom={10}
                    >
                        <Stack>
                            <Button width="full" onClick={onClose}>
                                {formatMessage(
                                    {
                                        id: 'product_list.modal.button.view_items',
                                        defaultMessage: 'View {prroductCount} items'
                                    },
                                    {
                                        prroductCount: productSearchResult?.total
                                    }
                                )}
                            </Button>
                            <Button width="full" variant="outline" onClick={() => resetFilters()}>
                                <FormattedMessage
                                    defaultMessage="Clear Filters"
                                    id="product_list.modal.button.clear_filters"
                                />
                            </Button>
                        </Stack>
                    </ModalFooter>
                </ModalContent>
            </Modal>
            <Drawer
                placement="bottom"
                isOpen={sortOpen}
                onClose={() => setSortOpen(false)}
                size="sm"
                motionPreset="slideInBottom"
                scrollBehavior="inside"
                isFullHeight={false}
                height="50%"
            >
                <DrawerOverlay />
                <DrawerContent marginTop={0}>
                    <DrawerHeader boxShadow="none">
                        <Text fontWeight="bold" fontSize="2xl">
                            <FormattedMessage
                                defaultMessage="Sort By"
                                id="product_list.drawer.title.sort_by"
                            />
                        </Text>
                    </DrawerHeader>
                    <DrawerCloseButton />
                    <DrawerBody>
                        {sortUrls.map((href, idx) => (
                            <Button
                                width="full"
                                onClick={() => {
                                    setSortOpen(false)
                                    history.push(href)
                                }}
                                fontSize={'md'}
                                key={idx}
                                marginTop={0}
                                variant="menu-link"
                            >
                                <Text
                                    as={
                                        selectedSortingOptionLabel?.label ===
                                            productSearchResult?.sortingOptions[idx]?.label && 'u'
                                    }
                                >
                                    {productSearchResult?.sortingOptions[idx]?.label}
                                </Text>
                            </Button>
                        ))}
                    </DrawerBody>
                </DrawerContent>
            </Drawer>
        </Box>
    )
}

ProductList.getTemplateName = () => 'product-list'

ProductList.shouldGetProps = ({previousLocation, location}) =>
    !previousLocation ||
    previousLocation.pathname !== location.pathname ||
    previousLocation.search !== location.search

ProductList.getProps = async ({res, params, location, api, ampClient}) => {
    const {categoryId} = params
    const urlParams = new URLSearchParams(location.search)
    const searchQuery = urlParams.get('q')
    const isSearch = !!searchQuery

    // Set the `cache-control` header values to align with the Commerce API settings.
    if (res) {
        res.set('Cache-Control', `max-age=${MAX_CACHE_AGE}`)
    }

    // In case somebody navigates to /search without a param
    if (!categoryId && !isSearch) {
        // We will simulate search for empty string
        return {searchQuery: ' ', productSearchResult: {}}
    }

    // Amplience in-grid content.

    const site = resolveSiteFromUrl(location.pathname)
    const l10nConfig = site.l10n
    const targetLocale = getTargetLocale({
        getUserPreferredLocales: () => {
            const {locale} = api.getConfig()
            return [locale]
        },
        l10nConfig
    })

    // Try fetch grid slots for this category from Amplience.
    const ampCategory = (
        await ampClient.fetchContent([{key: `category/${categoryId}`}], {locale: targetLocale})
    ).pop()

    const rawTopContent = ampCategory?.topContent || []
    const ids = rawTopContent.map(getIdsForContent)
    const ampTopContent =
        ids && ids.length ? await ampClient.fetchContent(ids, {locale: targetLocale}) : []

    let ampSlots = []

    if (ampCategory.type !== 'CONTENT_NOT_FOUND') {
        ampSlots = ampCategory.gridItem ?? []
    }

    const searchParams = parseSearchParams(location.search, false)

    if (categoryId && !searchParams.refine.includes(`cgid=${categoryId}`)) {
        searchParams.refine.push(`cgid=${categoryId}`)
    }

    searchParams.refine.push('htype=master')

    const [category, productSearchResult] = await Promise.all([
        isSearch
            ? Promise.resolve()
            : api.shopperProducts.getCategory({
                  parameters: {id: categoryId, levels: 0}
              }),
        api.shopperSearch.productSearch({
            parameters: searchParams
        })
    ])

    // Apply disallow list to refinements.
    productSearchResult.refinements = productSearchResult?.refinements?.filter(
        ({attributeId}) => !REFINEMENT_DISALLOW_LIST.includes(attributeId)
    )

    // The `isomorphic-sdk` returns error objects when they occur, so we
    // need to check the category type and throw if required.
    if (category?.type?.endsWith('category-not-found')) {
        throw new HTTPNotFound(category.detail)
    }

    return {
        searchQuery,
        productSearchResult,
        ampSlots,
        ampTopContent,
        ampBottomContent: ampCategory?.bottomContent || []
    }
}

ProductList.propTypes = {
    /**
     * The search result object showing all the product hits, that belong
     * in the supplied category.
     */
    productSearchResult: PropTypes.object,
    /*
     * Indicated that `getProps` has been called but has yet to complete.
     *
     * Notes: This prop is internally provided.
     */
    isLoading: PropTypes.bool,
    /*
     * Object that represents the current location, it consists of the `pathname`
     * and `search` values.
     *
     * Notes: This prop is internally provided.
     */
    location: PropTypes.object,
    searchQuery: PropTypes.string,
    onAddToWishlistClick: PropTypes.func,
    onRemoveWishlistClick: PropTypes.func,

    /**
     * Amplience specific - in-grid content positions and ids.
     */
    ampSlots: PropTypes.array,
    /**
     * Amplience specific - Top and bottom Slots.
     */
    ampTopContent: PropTypes.array,
    ampBottomContent: PropTypes.array
}

export default ProductList

const Sort = ({sortUrls, productSearchResult, basePath, ...otherProps}) => {
    const intl = useIntl()
    const history = useHistory()

    return (
        <FormControl data-testid="sf-product-list-sort" id="page_sort" width="auto" {...otherProps}>
            <Select
                value={basePath.replace(/(offset)=(\d+)/i, '$1=0')}
                onChange={({target}) => {
                    history.push(target.value)
                }}
                height={11}
                width="240px"
            >
                {sortUrls.map((href, index) => (
                    <option key={href} value={href}>
                        {intl.formatMessage(
                            {
                                id: 'product_list.select.sort_by',
                                defaultMessage: 'Sort By: {sortOption}'
                            },
                            {
                                sortOption: productSearchResult?.sortingOptions[index]?.label
                            }
                        )}
                    </option>
                ))}
            </Select>
        </FormControl>
    )
}
Sort.propTypes = {
    sortUrls: PropTypes.array,
    productSearchResult: PropTypes.object,
    basePath: PropTypes.string
}
